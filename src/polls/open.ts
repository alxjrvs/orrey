import { eq } from "drizzle-orm";
import type { Env } from "../env.ts";
import { db, schema } from "../db/index.ts";
import { mintId } from "../db/ids.ts";
import { SETTING_KEYS, getSetting } from "../db/settings.ts";
import { rememberUser } from "../db/users.ts";
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

  const windowHours =
    (await getSetting<number>(env, SETTING_KEYS.pollWindowHours)) ?? DEFAULT_WINDOW_HOURS;
  const closesAt = Math.floor(now.getTime() / 1000) + windowHours * 3600;
  const pollId = mintId();

  try {
    await db(env)
      .insert(schema.datePolls)
      .values({
        id: pollId,
        ...(targetSessionId ? { targetSessionId } : {}),
        ...(campaignId ? { campaignId } : {}),
        ...(gameId ? { gameId } : {}),
        ...(gameDayKind ? { gameDayKind } : {}),
        winRule: derived.winRule,
        ...(derived.winThreshold !== undefined ? { winThreshold: derived.winThreshold } : {}),
        openedBy: actor.id,
        closesAt,
        discordChannelId: channelId,
      });
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

  const d = db(env);
  await d.batch([
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

  // Moving an existing session is about who can make the new date, and the
  // roster is already the answer to "who".
  if (targetSessionId) return { winRule: "best_available" };

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
