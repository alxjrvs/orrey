import { asc, eq, inArray } from "drizzle-orm";
import type { Env } from "../env.ts";
import { db, schema } from "../db/index.ts";

/**
 * What a campaign's attendance rows already say.
 *
 * **No schema, and no cache.** Every number #47 asks for falls out of rows that
 * phases 2–5 already write, so nothing here stores a result. A stored tally is a
 * second source of truth that drifts the first time somebody corrects a
 * register — and the register is corrected often, which is what the correction
 * post is for. Counting on read costs a scan of one campaign's played sessions:
 * a few dozen rows a year.
 *
 * Split the way `src/attendance/render.ts` is split. `computeCampaignAttendance`
 * is pure, takes no clock and no database, and is where every judgement about
 * what these numbers mean lives; `loadCampaignAttendance` does the queries and
 * makes none of them.
 */

/** A played session, with who was on the roster for it and what the register says. */
export interface PlayedSession {
  sessionId: string;
  number: number | null;
  startsAt: number;
  state: string;
}

export interface Mark {
  sessionId: string;
  userId: string;
  /**
   * Tri-state on purpose. `null` is "nobody wrote the register" — neither
   * present nor absent — and reading it as a boolean turns every unanswered
   * session into somebody's absence.
   */
  attended: boolean | null;
}

export interface Member {
  userId: string;
  name: string;
  joinedAt: number;
}

export interface MemberAttendance {
  userId: string;
  name: string;
  /**
   * Played sessions since they joined that the register was actually written
   * for. Somebody who joined at session twenty is not rated on the first
   * nineteen, and a session Orrey holds no answer about is not one they failed
   * to come to.
   */
  played: number;
  attended: number;
  /**
   * `attended / played`, or **null** when `played` is zero. Null is "not
   * applicable", which is a different answer from `0` — and the page has to be
   * able to tell them apart, because "0.0" about a person reads as an
   * accusation and "nothing played yet" does not.
   */
  rate: number | null;
  /**
   * The current run of played sessions attended, most recent first. Broken by an
   * absence; **not** broken by a cancellation, because a session nobody could
   * attend says nothing about anybody.
   */
  streak: number;
}

export interface CampaignAttendance {
  sessionsPlayed: number;
  members: MemberAttendance[];
}

export function computeCampaignAttendance(input: {
  sessions: PlayedSession[];
  members: Member[];
  marks: Mark[];
}): CampaignAttendance {
  // `PLAYED` is the definition of played. "In the past" is a different question
  // and a wrong answer for a session nobody has corrected yet — and for one that
  // was called off, which is in the past and was never played at all.
  const played = input.sessions
    .filter((session) => session.state === "PLAYED")
    .sort((a, b) => a.startsAt - b.startsAt);

  const by = new Map<string, Map<string, boolean | null>>();
  for (const mark of input.marks) {
    const row = by.get(mark.userId) ?? new Map<string, boolean | null>();
    row.set(mark.sessionId, mark.attended);
    by.set(mark.userId, row);
  }

  const members = input.members.map((member) => {
    const marks = by.get(member.userId);
    // The window starts when they joined. Sessions played before they were on
    // the roster are not theirs to have missed.
    const theirs = played.filter((session) => session.startsAt >= member.joinedAt);

    let attended = 0;
    let counted = 0;
    for (const session of theirs) {
      const mark = marks?.get(session.sessionId);
      // Absent from the register and `null` in it are the same thing: no answer.
      if (mark === undefined || mark === null) continue;
      counted += 1;
      if (mark) attended += 1;
    }

    return {
      userId: member.userId,
      name: member.name,
      played: counted,
      attended,
      rate: counted === 0 ? null : attended / counted,
      streak: streakOf(theirs, marks),
    };
  });

  return { sessionsPlayed: played.length, members };
}

/**
 * The current run, counted backwards from the most recent played session.
 *
 * A session with no answer in the register neither continues a streak nor breaks
 * one — it is skipped, the same way it is skipped in the fraction. Only a
 * recorded absence stops the count.
 */
function streakOf(
  played: PlayedSession[],
  marks: Map<string, boolean | null> | undefined,
): number {
  let streak = 0;
  for (let i = played.length - 1; i >= 0; i--) {
    const mark = marks?.get(played[i]!.sessionId);
    if (mark === undefined || mark === null) continue;
    if (!mark) break;
    streak += 1;
  }
  return streak;
}

export async function loadCampaignAttendance(
  env: Env,
  campaignId: string,
): Promise<CampaignAttendance> {
  const d = db(env);

  const sessions = await d
    .select({
      sessionId: schema.sessions.id,
      number: schema.sessions.number,
      startsAt: schema.sessions.startsAt,
      state: schema.sessions.state,
    })
    .from(schema.sessions)
    .where(eq(schema.sessions.campaignId, campaignId))
    .orderBy(asc(schema.sessions.startsAt))
    .all();

  const members = await d
    .select({
      userId: schema.campaignMembers.userId,
      username: schema.users.username,
      globalName: schema.users.globalName,
      joinedAt: schema.campaignMembers.joinedAt,
    })
    .from(schema.campaignMembers)
    .innerJoin(schema.users, eq(schema.campaignMembers.userId, schema.users.discordId))
    .where(eq(schema.campaignMembers.campaignId, campaignId))
    .orderBy(asc(schema.campaignMembers.userId))
    .all();

  // Ninety ids a statement, inside D1's hundred-bound-parameter ceiling. A
  // campaign with more sessions than that is read a page at a time rather than
  // one statement per session.
  const ids = sessions.map((session) => session.sessionId);
  const marks: Mark[] = [];
  for (let from = 0; from < ids.length; from += 90) {
    const rows = await d
      .select({
        sessionId: schema.attendance.sessionId,
        userId: schema.attendance.userId,
        attended: schema.attendance.attended,
      })
      .from(schema.attendance)
      .where(inArray(schema.attendance.sessionId, ids.slice(from, from + 90)))
      .all();
    for (const row of rows) {
      marks.push({
        sessionId: row.sessionId,
        userId: row.userId,
        attended: row.attended === null ? null : row.attended === 1,
      });
    }
  }

  return computeCampaignAttendance({
    sessions,
    members: members.map((member) => ({
      userId: member.userId,
      name: member.globalName ?? member.username ?? member.userId,
      joinedAt: member.joinedAt,
    })),
    marks,
  });
}
