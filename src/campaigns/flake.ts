import { and, desc, eq, gte } from "drizzle-orm";
import type { Env } from "../env.ts";
import { db, schema } from "../db/index.ts";

/**
 * What somebody's attendance has actually looked like.
 *
 * **A query, never a counter.** A stored tally is a second source of truth that
 * drifts the first time somebody corrects a register, and the register is
 * corrected often — that is what `p3/9` is for. Counting on read costs a scan of
 * one campaign's played sessions, which is a few dozen rows a year.
 *
 * It says nothing useful for a couple of months after cutover, and that is
 * accepted: history starts empty, and a number computed from three sessions is
 * worse than no number because it looks like a number.
 *
 * It is **information for the organiser and never an automatic consequence.**
 * Nothing in Orrey reads this to decide anything — no seat is lost, no reminder
 * is skipped, no waitlist moves. It is shown in `/whos-in` and on the console
 * roster, where a person can weigh it.
 */
export interface Flake {
  userId: string;
  /** Sessions of this campaign that have been played since they joined. */
  played: number;
  /** How many of those they were marked as attending. */
  attended: number;
  /**
   * The current run of "said in, did not show", most recent first. Zero for
   * somebody whose last session was fine, however many they missed before it.
   */
  noShowStreak: number;
}

/** Below this, the answer is "not enough yet" rather than a proportion. */
export const ENOUGH = 4;

export async function flakeFor(
  env: Env,
  campaignId: string,
  userId: string,
): Promise<Flake> {
  // Somebody who joined at session ten is not "came to 2 of 12". The sessions
  // played before they were on the roster are not theirs to have missed, so the
  // window starts when they joined.
  const member = await db(env)
    .select({ joinedAt: schema.campaignMembers.joinedAt })
    .from(schema.campaignMembers)
    .where(
      and(
        eq(schema.campaignMembers.campaignId, campaignId),
        eq(schema.campaignMembers.userId, userId),
      ),
    )
    .get();

  // Played sessions in that window, newest first, with this person's row.
  const rows = await db(env)
    .select({
      startsAt: schema.sessions.startsAt,
      intent: schema.attendance.intent,
      attended: schema.attendance.attended,
    })
    .from(schema.sessions)
    .leftJoin(
      schema.attendance,
      and(
        eq(schema.attendance.sessionId, schema.sessions.id),
        eq(schema.attendance.userId, userId),
      ),
    )
    .where(
      and(
        eq(schema.sessions.campaignId, campaignId),
        eq(schema.sessions.state, "PLAYED"),
        ...(member ? [gte(schema.sessions.startsAt, member.joinedAt)] : []),
      ),
    )
    .orderBy(desc(schema.sessions.startsAt))
    .all();

  let attended = 0;
  let noShowStreak = 0;
  let streakOpen = true;

  for (const row of rows) {
    const came = row.attended === 1;
    if (came) attended++;

    // The streak is only the current run: the first session they did turn up to,
    // or simply did not claim they would, ends it. "Missed three, then came, then
    // missed one" is a streak of one, and saying three would be a lie about now.
    if (streakOpen) {
      if (row.intent === "in" && !came) noShowStreak++;
      else streakOpen = false;
    }
  }

  return { userId, played: rows.length, attended, noShowStreak };
}

/** Everybody on the roster, in one pass per person. */
export async function flakeForRoster(
  env: Env,
  campaignId: string,
): Promise<Flake[]> {
  const members = await db(env)
    .select({ userId: schema.campaignMembers.userId })
    .from(schema.campaignMembers)
    .where(eq(schema.campaignMembers.campaignId, campaignId))
    .all();

  return Promise.all(members.map((member) => flakeFor(env, campaignId, member.userId)));
}

/**
 * How to say it, or nothing at all.
 *
 * Nothing is the important half: under `ENOUGH` played sessions there is no
 * honest thing to say, and "1 of 2" reads as a judgement rather than as the
 * shrug it should be.
 */
export function flakeLine(flake: Flake): string | undefined {
  if (flake.played < ENOUGH) return undefined;

  const parts = [`came to ${flake.attended} of ${flake.played}`];
  if (flake.noShowStreak >= 2) {
    parts.push(`said in and missed the last ${flake.noShowStreak}`);
  }
  return parts.join("; ");
}

/** For the console, which shows the numbers rather than a sentence. */
export function attendanceRate(flake: Flake): number | null {
  return flake.played === 0 ? null : flake.attended / flake.played;
}

/** Whether this campaign has played anything yet — to explain an empty answer. */
export function hasHistory(env: Env, campaignId: string): Promise<boolean> {
  return db(env)
    .select({ id: schema.sessions.id })
    .from(schema.sessions)
    .where(
      and(
        eq(schema.sessions.campaignId, campaignId),
        eq(schema.sessions.state, "PLAYED"),
      ),
    )
    .get()
    .then((row) => row !== undefined);
}
