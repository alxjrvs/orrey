import { and, asc, desc, eq } from "drizzle-orm";
import type { Env } from "../env.ts";
import { db, schema } from "../db/index.ts";
import { logsForCampaign, type SessionLogs } from "./logs.ts";
import { ENOUGH, attendanceRate, flakeForRoster, hasHistory } from "../campaigns/flake.ts";

/**
 * What a campaign has already done.
 *
 * The other half of `p6/5`: that page is the campaign's *plan* and this is its
 * *record*, and they are separate because they fail differently. A plan is wrong
 * when the cadence or the roster is wrong. A record is wrong when a denominator
 * counts sessions somebody could not have been at — which is a number that
 * accuses someone, and the only defence against it is that the count and the
 * table it is counted from are read together.
 *
 * So both are here, in one model and one PR. Reviewing the streak without the
 * sessions it was counted from is reviewing a number nobody can check.
 *
 * Nothing here decides anything. Flake memory is **information for the
 * organiser and never an automatic consequence** — no seat is lost, no reminder
 * is skipped, no waitlist moves — and nothing in phase 6 reads it back.
 */
export interface RegisterEntry {
  userId: string;
  name: string;
  /** What they said beforehand. Null is "never asked", not "said nothing". */
  intent: "in" | "out" | "maybe" | null;
  /**
   * Whether they came. **Null is not false.** A session Orrey holds no answer
   * about is not one they failed to turn up to, and the two are shown
   * differently everywhere they appear.
   */
  attended: boolean | null;
  /** Whether a person decided that, as against Orrey having assumed it. */
  corrected: boolean;
}

export interface PlayedSession {
  sessionId: string;
  number: number | null;
  startsAt: number;
  location: string | null;
  register: RegisterEntry[];
  came: number;
  missed: number;
  /** Rows the register was never written for. Counted toward neither side. */
  unrecorded: number;
}

export interface MemberRecord {
  userId: string;
  name: string;
  /** Played sessions since they joined that the register was written for. */
  played: number;
  attended: number;
  /**
   * Null under `ENOUGH` played sessions, and that is the design's own warning
   * made structural rather than left to a caption. "Came to 1 of 2" reads as a
   * judgement instead of the shrug it should be, so there is no number to render
   * until there is one worth rendering.
   */
  rate: number | null;
  enough: boolean;
  /** The current run of "said in, did not show". Zero when the last one was fine. */
  noShowStreak: number;
}

export interface CampaignHistory {
  sessions: PlayedSession[];
  members: MemberRecord[];
  /**
   * The written record beside the counted one, grouped under the evening each
   * entry belongs to. A recap without its session is a paragraph about nothing.
   */
  logs: SessionLogs[];
  /**
   * Why there is nothing to show, in words. History starts empty, and a page
   * that renders a blank table and a column of zeroes instead of saying so is a
   * page that looks broken for the first couple of months.
   */
  note: string | null;
}

export async function campaignHistory(env: Env, campaignId: string): Promise<CampaignHistory> {
  const sessions = await playedSessions(env, campaignId);
  const members = (await flakeForRoster(env, campaignId)).map((flake) => ({
    userId: flake.userId,
    name: nameOf(sessions, flake.userId) ?? `<@${flake.userId}>`,
    played: flake.played,
    attended: flake.attended,
    // Under ENOUGH there is no honest proportion to state, so there is none.
    rate: flake.played >= ENOUGH ? attendanceRate(flake) : null,
    enough: flake.played >= ENOUGH,
    noShowStreak: flake.noShowStreak,
  }));

  return {
    sessions,
    members,
    logs: await logsForCampaign(env, campaignId),
    note: await noteFor(env, campaignId, sessions, members),
  };
}

/**
 * The played sessions, newest first, each with its register.
 *
 * `PLAYED` and nothing else. A cancelled session is not one anybody failed to
 * come to, and a scheduled one has not happened — putting either in the
 * denominator is the failure this whole slice is written against.
 */
async function playedSessions(env: Env, campaignId: string): Promise<PlayedSession[]> {
  const rows = await db(env)
    .select({
      sessionId: schema.sessions.id,
      number: schema.sessions.number,
      startsAt: schema.sessions.startsAt,
      location: schema.sessions.location,
      userId: schema.attendance.userId,
      intent: schema.attendance.intent,
      attended: schema.attendance.attended,
      attendedSource: schema.attendance.attendedSource,
      username: schema.users.username,
      globalName: schema.users.globalName,
    })
    .from(schema.sessions)
    .leftJoin(schema.attendance, eq(schema.attendance.sessionId, schema.sessions.id))
    .leftJoin(schema.users, eq(schema.attendance.userId, schema.users.discordId))
    .where(and(eq(schema.sessions.campaignId, campaignId), eq(schema.sessions.state, "PLAYED")))
    .orderBy(desc(schema.sessions.startsAt), asc(schema.attendance.userId))
    .all();

  const by = new Map<string, PlayedSession>();

  for (const row of rows) {
    let session = by.get(row.sessionId);
    if (!session) {
      session = {
        sessionId: row.sessionId,
        number: row.number,
        startsAt: row.startsAt,
        location: row.location,
        register: [],
        came: 0,
        missed: 0,
        unrecorded: 0,
      };
      by.set(row.sessionId, session);
    }

    // The left join gives one all-null row for a session nobody has a row on.
    // That is a played session with an empty register, not a person.
    if (row.userId === null) continue;

    const attended = row.attended === null ? null : row.attended === 1;
    session.register.push({
      userId: row.userId,
      name: row.globalName ?? row.username ?? `<@${row.userId}>`,
      intent: row.intent,
      attended,
      corrected: row.attendedSource === "gm",
    });

    if (attended === null) session.unrecorded++;
    else if (attended) session.came++;
    else session.missed++;
  }

  return [...by.values()];
}

/** The name the register already carries, so this costs no second query. */
function nameOf(sessions: PlayedSession[], userId: string): string | undefined {
  for (const session of sessions) {
    const entry = session.register.find((row) => row.userId === userId);
    if (entry) return entry.name;
  }
  return undefined;
}

async function noteFor(
  env: Env,
  campaignId: string,
  sessions: PlayedSession[],
  members: MemberRecord[],
): Promise<string | null> {
  if (sessions.length === 0) {
    // `hasHistory` and not `sessions.length`, because they can disagree: a
    // campaign whose played sessions are all on a *different* campaign id is not
    // a thing, but a campaign whose roster is empty and whose sessions are not
    // is, and the sentence should be about the history rather than the roster.
    return (await hasHistory(env, campaignId))
      ? "Nothing to count here yet."
      : "Nothing played yet. History starts empty, so these numbers say nothing useful for the first couple of months.";
  }
  if (members.length > 0 && members.every((member) => !member.enough)) {
    return `Fewer than ${ENOUGH} played sessions each, which is too few to read a proportion from. The table below is the whole record.`;
  }
  return null;
}
