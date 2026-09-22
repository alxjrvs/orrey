import type { Env } from "../env.ts";
import { db, schema } from "../db/index.ts";
import { eq } from "drizzle-orm";
import { SETTING_DEFAULTS, SETTING_KEYS, settingOr } from "../db/settings.ts";
import { sameTimeDaysLater } from "../campaigns/recurrence.ts";
import { loadProjectionTarget } from "../projection/target.ts";
import { rosterOf } from "../campaigns/roster.ts";
import { openPoll, type OpenResult } from "./open.ts";
import type { ParsedDate } from "./parse-dates.ts";

/**
 * What happens when somebody on the roster cannot make it.
 *
 * Not a cancellation. #1 is explicit that when the answer is no the response is a
 * date poll, and the veto rule does not change that — it changes *what counts as
 * no*. One `out` is the answer; this is the question that follows it.
 *
 * Run from the drain, off the `session.reschedule` job, rather than from the click
 * that vetoed. Three seconds is what an interaction has, and a poll is a D1 batch
 * plus a Discord post: the click rewrites its own message and arms this, which is
 * the same division every other posted consequence in this repo is built on.
 */
export const RESCHEDULE_JOB = "session.reschedule";

/**
 * How many days get proposed, and why it is a handful rather than the next
 * fortnight.
 *
 * A fortnightly game that loses a Monday is nearly always looking for a different
 * evening in the same week, not for a different week — the week after is when the
 * next session already is. So the proposal is the days immediately after the one
 * that fell through, at the same time, which for a Monday game is Tuesday to
 * Friday.
 *
 * It is a *proposal*. Nothing here decides anything: the organiser can add dates
 * with `/reschedule`, pick a date the rule did not, or close the poll and leave
 * the session where it is.
 */
export const PROPOSED_DAYS = 4;

/**
 * Everybody, and not a fraction of everybody.
 *
 * `quorum_of_roster` at 1.0 resolves to `ceil(rosterSize * 1)` — the whole table.
 * That is the one place the veto rule leaves a count worth having: a date only
 * works if *everyone assigned to be there* can make it, which is the same
 * standard that moved the session in the first place. Anything less would move a
 * game onto a night it would only have to move off again.
 *
 * The rule already computed exactly this, so this phase added no win rule.
 */
export const WHOLE_ROSTER_THRESHOLD = 1;

export type RescheduleResult =
  | { ok: true; pollId: string }
  | { ok: false; reason: "no-session" | "no-campaign" | "no-dates" | "nobody" | OpenFailure };

type OpenFailure = Extract<OpenResult, { ok: false }>["reason"];

export async function openRescheduleFor(
  env: Env,
  sessionId: string,
  { by, now }: { by?: string | undefined; now: Date },
): Promise<RescheduleResult> {
  const target = await loadProjectionTarget(env, sessionId);
  if (!target) return { ok: false, reason: "no-session" };

  const { session, campaign } = target;
  // A game day has its own machinery for this and no cadence to propose around.
  if (!campaign) return { ok: false, reason: "no-campaign" };

  const roster = await rosterOf(env, campaign.id);
  // Nobody to ask, and nothing a whole-roster rule could mean. This is
  // unreachable from a veto — a veto is a roster member — and worth refusing by
  // name rather than opening a poll no answer can ever win.
  if (roster.length === 0) return { ok: false, reason: "nobody" };

  const timezone = await settingOr(env, SETTING_KEYS.timezone, SETTING_DEFAULTS.timezone);
  const dates = proposalsFor(session, { timezone, now });
  if (dates.length === 0) return { ok: false, reason: "no-dates" };

  const actor = await actorFor(env, by ?? roster[0]?.userId);

  const opened = await openPoll(env, {
    actor,
    targetSessionId: sessionId,
    // Carried explicitly: a whole-roster rule cannot be computed without knowing
    // whose roster, and the poll's own `campaign_id` is where every reader of it
    // looks.
    campaignId: campaign.id,
    winRule: "quorum_of_roster",
    winThreshold: WHOLE_ROSTER_THRESHOLD,
    channelId: campaign.discordChannelId ?? undefined,
    dates,
    now,
  });

  return opened.ok ? { ok: true, pollId: opened.pollId } : { ok: false, reason: opened.reason };
}

/**
 * The days after the one that did not work, at the same time of day, skipping
 * anything already in the past.
 *
 * The skip is what makes this safe to run late. A veto that arrives on the evening
 * itself — or a job that failed and is retried the next morning — would otherwise
 * propose dates that had already gone, and a poll whose first option is yesterday
 * is a poll nobody can answer honestly.
 */
export function proposalsFor(
  session: { startsAt: number; endsAt: number },
  { timezone, now }: { timezone: string; now: Date },
): ParsedDate[] {
  const duration = session.endsAt - session.startsAt;
  const after = Math.floor(now.getTime() / 1000);

  const dates: ParsedDate[] = [];
  for (let day = 1; day <= PROPOSED_DAYS; day++) {
    const startsAt = sameTimeDaysLater(session.startsAt, day, timezone);
    if (startsAt <= after) continue;
    dates.push({
      startsAt,
      endsAt: startsAt + duration,
      // What the poll post quotes back. `parseDates` fills this with the line
      // somebody typed; nobody typed these, so it says what they are.
      source: `${day} ${day === 1 ? "day" : "days"} later`,
    });
  }
  return dates;
}

/**
 * Whose name the poll is opened in.
 *
 * The person whose `out` opened it, which is the honest answer to "who asked
 * this" — and `openPoll` writes it to `opened_by`. They are already in `users`,
 * because an intent row cannot exist without one, so this is a read rather than
 * an invention: a poll attributed to a username guessed from an id would be a
 * name in the audit trail that belongs to nobody.
 */
async function actorFor(env: Env, userId: string | undefined) {
  const row = userId
    ? await db(env)
        .select({ username: schema.users.username, globalName: schema.users.globalName })
        .from(schema.users)
        .where(eq(schema.users.discordId, userId))
        .get()
    : undefined;

  return {
    id: userId ?? "orrey",
    username: row?.username ?? userId ?? "orrey",
    global_name: row?.globalName ?? null,
  };
}
