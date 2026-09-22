import { eq } from "drizzle-orm";
import type { Env } from "../env.ts";
import { db, schema } from "../db/index.ts";
import { mintId } from "../db/ids.ts";
import { SETTING_KEYS, getSetting } from "../db/settings.ts";
import { rememberUser } from "../db/users.ts";
import { loadProjectionTarget } from "../projection/target.ts";
import { attendanceRows } from "../attendance/rows.ts";
import { quorumOf } from "../attendance/quorum.ts";
import { armPollClose, CLOSE_JOB } from "./schedule.ts";
import type { ParsedDate } from "./parse-dates.ts";
import type { WinRule } from "./win-rule.ts";
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
  | { ok: false; reason: "no-channel" }
  | { ok: false; reason: "needs-game" }
  | { ok: false; reason: "needs-kind" }
  | { ok: false; reason: "no-dates" };

/**
 * What a poll with no target is for.
 *
 * A poll that names a session is asking "when instead?". A poll that names none
 * is looking for a day that does not exist yet — which needs to know what would
 * be played on it and whether it is one table or several, because those are the
 * two things the announcement and the seating both read.
 */
export interface Untargeted {
  gameId: string;
  gameDayKind: "single" | "multi";
  winRule?: WinRule | undefined;
  winThreshold?: number | undefined;
}

export async function openPoll(
  env: Env,
  {
    actor,
    targetSessionId,
    campaignId,
    gameId,
    gameDayKind,
    winRule,
    winThreshold,
    channelId,
    dates,
    now,
  }: {
    actor: InteractionUser;
    targetSessionId?: string | undefined;
    campaignId?: string | undefined;
    gameId?: string | undefined;
    gameDayKind?: "single" | "multi" | undefined;
    winRule?: WinRule | undefined;
    winThreshold?: number | undefined;
    channelId: string | undefined;
    dates: ParsedDate[];
    now: Date;
  },
): Promise<OpenResult> {
  if (!channelId) return { ok: false, reason: "no-channel" };
  if (dates.length === 0) return { ok: false, reason: "no-dates" };

  /**
   * An untargeted poll has to say what it is for. Both are refused by name
   * rather than defaulted, because a guess here is a game day nobody can
   * announce and a seating plan phase 5 cannot size.
   */
  if (!targetSessionId) {
    if (!gameId) return { ok: false, reason: "needs-game" };
    if (!gameDayKind) return { ok: false, reason: "needs-kind" };
  }

  await rememberUser(env, actor);

  /**
   * What "winning" means, when nobody said.
   *
   * `min_players` off the game's own minimum, because that number is already the
   * answer to "how many does it take" and having it in two places is having it
   * wrong in one. A game that does not state a minimum falls back to
   * `best_available` — a threshold invented here would be a threshold nobody
   * agreed to.
   */
  const derived = await defaultRuleFor(env, { targetSessionId, gameId, winRule, winThreshold });

  /**
   * A poll about a session belongs to that session's campaign, whether the caller
   * said so or not.
   *
   * `quorum_of_roster` cannot be computed without knowing *whose* roster, and the
   * readers of a poll all ask `date_polls.campaign_id` for it. The Discord
   * `/reschedule` path passes it; the console's passes whatever the request body
   * held, which for a targeted poll is often nothing — and a whole-roster rule on
   * a poll with no campaign resolves to a roster of zero, under which no date can
   * ever win. Filling it from the session is not a default: it is the same fact,
   * read from the row that holds it.
   */
  const parent = campaignId ?? (await campaignOf(env, targetSessionId));

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
        ...(parent ? { campaignId: parent } : {}),
        ...(gameId ? { gameId } : {}),
        ...(gameDayKind ? { gameDayKind } : {}),
        winRule: derived.winRule,
        ...(derived.winThreshold !== undefined ? { winThreshold: derived.winThreshold } : {}),
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

async function defaultRuleFor(
  env: Env,
  {
    targetSessionId,
    gameId,
    winRule,
    winThreshold,
  }: {
    targetSessionId?: string | undefined;
    gameId?: string | undefined;
    winRule?: WinRule | undefined;
    winThreshold?: number | undefined;
  },
): Promise<{ winRule: WinRule; winThreshold?: number }> {
  // An explicit choice always wins. The derivation is a default, not a policy.
  if (winRule) {
    return winThreshold === undefined ? { winRule } : { winRule, winThreshold };
  }

  /**
   * Moving an existing session is about who can make the new date, and the roster
   * is already the answer to "who" — so on a campaign whose attendance is
   * unanimous, the bar for the new date is the same bar that moved it off the old
   * one: **everybody assigned to be there**. `quorum_of_roster` at 1.0 is exactly
   * that, so nothing new had to be invented for it.
   *
   * This is the one place the veto rule leaves a count worth having, and #173 says
   * why: a date that only most of the table can make is a date the game would have
   * to move off again.
   *
   * The rule is asked, not re-derived. `quorumOf` is the single place that knows
   * when a campaign is unanimous, and a second copy of that test here would be one
   * that disagrees with the post by the phase after next. Everything else — a
   * forming campaign, a game day, a campaign with nobody entered, one that set a
   * quorum — keeps `best_available`, which is what a poll about a table still being
   * found should have.
   */
  if (targetSessionId) {
    return (await isUnanimous(env, targetSessionId))
      ? { winRule: "quorum_of_roster", winThreshold: WHOLE_ROSTER }
      : { winRule: "best_available" };
  }

  const game = gameId
    ? await db(env)
        .select({ minPlayers: schema.games.minPlayers })
        .from(schema.games)
        .where(eq(schema.games.id, gameId))
        .get()
    : undefined;

  return game?.minPlayers
    ? { winRule: "min_players", winThreshold: game.minPlayers }
    : { winRule: "best_available" };
}

/** Whose campaign a session belongs to, for a caller that did not say. */
async function campaignOf(env: Env, sessionId: string | undefined) {
  if (!sessionId) return undefined;
  const row = await db(env)
    .select({ campaignId: schema.sessions.campaignId })
    .from(schema.sessions)
    .where(eq(schema.sessions.id, sessionId))
    .get();
  return row?.campaignId ?? undefined;
}

/**
 * `ceil(rosterSize * 1)` is the whole roster, which is what "everyone assigned to
 * be there can make it" means as a number.
 */
const WHOLE_ROSTER = 1;

/**
 * Whether this session's attendance is unanimous — asked of the one function that
 * decides it, given the same rows the post renders from.
 */
async function isUnanimous(env: Env, sessionId: string): Promise<boolean> {
  const target = await loadProjectionTarget(env, sessionId);
  if (!target) return false;
  return quorumOf(target, await attendanceRows(env, sessionId)).rule === "unanimous";
}
