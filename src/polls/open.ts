import { eq } from "drizzle-orm";
import type { Env } from "../env.ts";
import { db, schema } from "../db/index.ts";
import { mintId } from "../db/ids.ts";
import { SETTING_KEYS, getSetting } from "../db/settings.ts";
import { rememberUser } from "../db/users.ts";
import { armPollClose, CLOSE_JOB } from "./schedule.ts";
import type { ParsedDate } from "./parse-dates.ts";
import type { InteractionUser } from "../discord/types.ts";

/**
 * Writing a poll and asking for it to be posted.
 *
 * Both entry points — `/reschedule` and the button on a post — land here, so
 * there is one place that decides what a poll is and one place that arms its
 * jobs.
 */
export const POST_JOB = "poll.post";

/** How long answering stays open, unless somebody says otherwise. */
export const DEFAULT_WINDOW_HOURS = 72;

export type OpenResult =
  | { ok: true; pollId: string }
  | { ok: false; reason: "already-open"; pollId?: string }
  | { ok: false; reason: "no-channel" };

export async function openPoll(
  env: Env,
  {
    actor,
    targetSessionId,
    campaignId,
    gameId,
    gameDayKind,
    channelId,
    dates,
    now,
  }: {
    actor: InteractionUser;
    targetSessionId?: string | undefined;
    campaignId?: string | undefined;
    gameId?: string | undefined;
    gameDayKind?: "single" | "multi" | undefined;
    channelId: string | undefined;
    dates: ParsedDate[];
    now: Date;
  },
): Promise<OpenResult> {
  if (!channelId) return { ok: false, reason: "no-channel" };

  await rememberUser(env, actor);

  const windowHours =
    (await getSetting<number>(env, SETTING_KEYS.pollWindowHours)) ?? DEFAULT_WINDOW_HOURS;
  const closesAt = Math.floor(now.getTime() / 1000) + windowHours * 3600;
  const pollId = mintId();

  const d = db(env);
  try {
    /**
     * One batch, and that is the whole point.
     *
     * The `date_polls` row **is** the lock: `date_polls_one_open_per_session` is
     * a partial unique index on `target_session_id WHERE status = 'open'`, so
     * writing that row is what claims the session. Committing it on its own and
     * then writing the dates and the post job separately meant a throw in
     * between left a poll with no dates and no post — holding the index against
     * that session for good, with nothing able to open another and nothing able
     * to close this one, because closing goes through a post nobody ever made.
     *
     * D1 runs a batch as one transaction, so either the claim and the thing it
     * claims for both land, or neither does. The duplicate refusal still works:
     * a unique violation inside a batch surfaces with the same message one
     * `cause` deeper, which `isDuplicateOpenPoll` already walks.
     */
    await d.batch([
      d.insert(schema.datePolls).values({
        id: pollId,
        ...(targetSessionId ? { targetSessionId } : {}),
        ...(campaignId ? { campaignId } : {}),
        ...(gameId ? { gameId } : {}),
        ...(gameDayKind ? { gameDayKind } : {}),
        openedBy: actor.id,
        closesAt,
        discordChannelId: channelId,
      }),
      d.insert(schema.pollDates).values(
        dates.map((date) => ({
          id: mintId(),
          pollId,
          startsAt: date.startsAt,
          endsAt: date.endsAt,
        })),
      ),
      // Post it now. From a job rather than from inside this interaction, so the
      // send stays inside the governor and off the three-second budget.
      d.insert(schema.jobs).values({
        id: `${POST_JOB}:${pollId}`,
        kind: POST_JOB,
        payload: { pollId },
        idempotencyKey: `${POST_JOB}:${pollId}`,
        runAt: Math.floor(now.getTime() / 1000),
      }),
    ]);
  } catch (error) {
    // The refusal comes from the partial unique index, not from a prior read.
    // "Select, then insert" races with itself — two `/reschedule` calls a second
    // apart would both see no open poll and both write one — and stopping that
    // is exactly what the index is for.
    if (isDuplicateOpenPoll(error)) {
      return { ok: false, reason: "already-open", ...(await openPollFor(env, targetSessionId)) };
    }
    throw error;
  }

  await armPollClose(env, pollId, closesAt);

  return { ok: true, pollId };
}

/** Which poll is in the way, so the refusal can point at it. */
async function openPollFor(env: Env, targetSessionId: string | undefined) {
  if (!targetSessionId) return {};
  const row = await db(env)
    .select({ id: schema.datePolls.id, messageId: schema.datePolls.discordMessageId })
    .from(schema.datePolls)
    .where(eq(schema.datePolls.targetSessionId, targetSessionId))
    .get();
  return row ? { pollId: row.id } : {};
}

/**
 * The index said no.
 *
 * Drizzle wraps the D1 failure and D1 wraps SQLite's, so the text naming the
 * index is two or three `cause`s down. Matching on the top-level message alone
 * would read every constraint failure as "already open" — including one that is
 * not — so the chain is walked and the *table* is named as well as the shape of
 * the error.
 */
function isDuplicateOpenPoll(error: unknown): boolean {
  for (let cause: unknown = error, depth = 0; cause && depth < 5; depth++) {
    const message = cause instanceof Error ? cause.message : String(cause);
    if (
      message.includes("UNIQUE constraint failed") &&
      message.includes("date_polls.target_session_id")
    ) {
      return true;
    }
    cause = cause instanceof Error ? cause.cause : undefined;
  }
  return false;
}

/** For the console and the tests: cancel a poll's timers without deleting it. */
export function disarmPollClose(env: Env, pollId: string): Promise<unknown> {
  return db(env)
    .update(schema.jobs)
    .set({ state: "cancelled", claimedUntil: null, lastError: null })
    .where(eq(schema.jobs.id, `${CLOSE_JOB}:${pollId}`));
}

