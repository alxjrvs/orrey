import { eq } from "drizzle-orm";
import type { Env } from "../env.ts";
import { db, schema } from "../db/index.ts";
import { SETTING_KEYS, getSetting } from "../db/settings.ts";
import { getUser } from "../db/users.ts";
import { parseDates } from "../polls/parse-dates.ts";
import { openPoll } from "../polls/open.ts";
import type { WinRule } from "../polls/win-rule.ts";

/**
 * The console's way in to the same `openPoll` the modal uses.
 *
 * A caller, not a second implementation. Everything that decides what a poll is
 * lives in `src/polls/open.ts`; this reads a form body, parses the dates with
 * the same pure function the modal does, and hands over.
 */
export interface ConsolePollBody {
  /**
   * The session this poll is about moving. Set for the session rail's action;
   * absent for the untargeted poll that goes looking for a game day.
   */
  targetSessionId?: unknown;
  gameId?: unknown;
  gameDayKind?: unknown;
  campaignId?: unknown;
  winRule?: unknown;
  winThreshold?: unknown;
  /** The same one-per-line paragraph the modal takes. */
  dates?: unknown;
  durationMinutes?: unknown;
}

export type ConsolePollResult =
  | { ok: true; pollId: string }
  | { ok: false; error: string; status: 400 | 409 | 503 };

const KINDS = new Set(["single", "multi"]);
const RULES = new Set<WinRule>([
  "min_players",
  "quorum_of_roster",
  "best_available",
  "organiser_picks",
]);

/** Four hours, when the game does not say and the form does not either. */
const DEFAULT_DURATION_MINUTES = 240;

export async function openPollFromConsole(
  env: Env,
  body: ConsolePollBody,
  actorUserId: string,
): Promise<ConsolePollResult> {
  const gameId = typeof body.gameId === "string" ? body.gameId : undefined;
  const gameDayKind =
    typeof body.gameDayKind === "string" && KINDS.has(body.gameDayKind)
      ? (body.gameDayKind as "single" | "multi")
      : undefined;
  const winRule =
    typeof body.winRule === "string" && RULES.has(body.winRule as WinRule)
      ? (body.winRule as WinRule)
      : undefined;

  // A rule the form does not know is a rule Orrey does not have. Storing it
  // would mean a poll that can never be decided.
  if (body.winRule !== undefined && !winRule) {
    return { ok: false, error: "that is not a win rule Orrey knows", status: 400 };
  }
  if (typeof body.dates !== "string" || body.dates.trim() === "") {
    return { ok: false, error: "say which days might work, one per line", status: 400 };
  }

  const game = gameId
    ? await db(env)
        .select()
        .from(schema.games)
        .where(eq(schema.games.id, gameId))
        .get()
    : undefined;

  const timeZone = (await getSetting<string>(env, SETTING_KEYS.timezone)) ?? "Europe/London";
  const minutes =
    (typeof body.durationMinutes === "number" ? body.durationMinutes : undefined) ??
    game?.defaultDurationMinutes ??
    DEFAULT_DURATION_MINUTES;

  const parsed = parseDates({
    text: body.dates,
    timeZone,
    durationSeconds: minutes * 60,
    now: new Date(),
  });

  if (!parsed.ok) {
    return {
      ok: false,
      status: 400,
      error: parsed.tooMany
        ? `that is ${parsed.tooMany} dates — a poll takes ten`
        : `could not read: ${parsed.unreadable.join("; ")}`,
    };
  }

  const actor = await getUser(env, actorUserId);

  const opened = await openPoll(env, {
    // The console's caller is a Discord id, so the user row is the actor. It
    // exists: the session cookie was minted from an identify exchange.
    actor: {
      id: actorUserId,
      username: actor?.username ?? actorUserId,
      global_name: actor?.globalName ?? null,
    },
    ...(gameId ? { gameId } : {}),
    ...(gameDayKind ? { gameDayKind } : {}),
    ...(typeof body.campaignId === "string" ? { campaignId: body.campaignId } : {}),
    ...(typeof body.targetSessionId === "string"
      ? { targetSessionId: body.targetSessionId }
      : {}),
    ...(winRule ? { winRule } : {}),
    ...(typeof body.winThreshold === "number" ? { winThreshold: body.winThreshold } : {}),
    channelId: (await getSetting<string>(env, SETTING_KEYS.schedulingChannelId)) ?? undefined,
    dates: parsed.dates,
    now: new Date(),
  });

  if (opened.ok) return { ok: true, pollId: opened.pollId };

  switch (opened.reason) {
    case "needs-game":
      return { ok: false, error: "which game is it for?", status: 400 };
    case "needs-kind":
      return { ok: false, error: "one table or several?", status: 400 };
    case "no-dates":
      return { ok: false, error: "say which days might work", status: 400 };
    case "already-open":
      // The same sentence the bot gives, because it is the same refusal coming
      // from the same partial unique index.
      return { ok: false, error: "there is already a poll open for that", status: 409 };
    default:
      return {
        ok: false,
        // A missing setting, not a refused person — the same shape the roles
        // check uses when the organiser role has not been seeded.
        error: `setting ${SETTING_KEYS.schedulingChannelId} is not seeded — there is nowhere to post`,
        status: 503,
      };
  }
}
