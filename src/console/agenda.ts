import { and, asc, eq, gte, inArray, lt } from "drizzle-orm";
import type { Env } from "../env.ts";
import { db, schema } from "../db/index.ts";
import { SETTING_DEFAULTS, SETTING_KEYS } from "../db/settings.ts";
import { quorumOf, type Quorum } from "../attendance/quorum.ts";
import type { AttendanceRow } from "../attendance/render.ts";
import { isProjectable, sessionTitle, type ProjectionTarget } from "../projection/target.ts";

/**
 * One query behind two agendas.
 *
 * The console's agenda, the month grid and `/upcoming` all ask the same question
 * — what is on, between these two moments, and does it run — and #43 calls the
 * console page "the counterpart to `/upcoming`". A counterpart that computes the
 * same numbers a second way is a counterpart that will disagree with the first
 * one by phase 7, so there is one of these and everything reads it.
 *
 * **The window is an argument**, half-open, so that a month grid can ask for a
 * month that has already been and gone. So is the clock: this is a function of
 * rows and an `asOf`, the way `renderAttendancePost` is, which is what makes
 * what a page renders the same thing a test can render.
 */
export interface AgendaTally {
  in: number;
  out: number;
  maybe: number;
  /** On the roster and has not said. Not the same as "out", and never counted as it. */
  noReply: number;
}

export interface AgendaRow {
  sessionId: string;
  title: string;
  startsAt: number;
  /**
   * The calendar day this falls on **in the guild's zone**, as `YYYY-MM-DD`, and
   * the heading a page puts above it.
   *
   * Grouped here rather than in the browser, and that is not only about being
   * testable in a repo with no DOM harness. Two people in two zones must not see
   * a session fall on different days: a Friday-evening session is a Friday
   * session for the table, whatever the reader's laptop says.
   */
  day: string;
  dayLabel: string;
  endsAt: number;
  state: string;
  location: string | null;
  /** Exactly one of these is set — `hasExactlyOneParent` is the rule. */
  campaignId: string | null;
  gameDayId: string | null;
  /** How many people the roster holds, so a tally reads against something. */
  rosterSize: number;
  tally: AgendaTally;
  /** The same shape `/upcoming` and the attendance post already render. */
  quorum: Quorum;
  /**
   * Whether the clock has raised it. Read off `sessions.state` and **never**
   * recomputed here: the jeopardy check is what decides, and a page that decided
   * it again would disagree with the notice that went out.
   */
  inJeopardy: boolean;
}

/** The envelope every page of the console reuses. */
export interface Agenda {
  /**
   * The console carries the same as-of line the Discord posts do, for the same
   * reason: what it shows is a reading, and the reader should know when of.
   */
  asOf: number;
  rows: AgendaRow[];
}

export async function agendaBetween(
  env: Env,
  from: number,
  to: number,
  asOf: Date,
  timeZone: string = SETTING_DEFAULTS[SETTING_KEYS.timezone],
): Promise<Agenda> {
  // Half-open. A session starting exactly at `to` belongs to the next window,
  // or a month grid would show the first of next month twice.
  const rows = await db(env)
    .select({
      session: schema.sessions,
      campaign: schema.campaigns,
      gameDay: schema.gameDays,
      game: schema.games,
    })
    .from(schema.sessions)
    .leftJoin(schema.campaigns, eq(schema.sessions.campaignId, schema.campaigns.id))
    .leftJoin(schema.gameDays, eq(schema.sessions.gameDayId, schema.gameDays.id))
    .leftJoin(schema.games, eq(schema.gameDays.gameId, schema.games.id))
    .where(and(gte(schema.sessions.startsAt, from), lt(schema.sessions.startsAt, to)))
    .orderBy(asc(schema.sessions.startsAt), asc(schema.sessions.id))
    .all();

  // A campaign on hiatus contributes nothing, for the same reason
  // `isProjectable` refuses to publish it: a console listing a session Orrey is
  // not putting on anybody's calendar shows the organiser a plan Discord does
  // not have. One rule, asked once, rather than a second answer that drifts.
  const live = rows
    .map((row) => ({ ...row, target: row as ProjectionTarget }))
    .filter(({ target }) => isProjectable(target));

  if (live.length === 0) return { asOf: unix(asOf), rows: [] };

  const answers = await answersFor(env, live.map(({ session }) => session.id));
  const rosters = await rosterMembers(
    env,
    live.map(({ campaign }) => campaign?.id).filter((id): id is string => id !== undefined && id !== null),
    live.map(({ gameDay }) => gameDay?.id).filter((id): id is string => id !== undefined && id !== null),
  );

  return {
    asOf: unix(asOf),
    rows: live.map((row) => {
      const said = answers.get(row.session.id) ?? [];
      const assigned = row.campaign
        ? (rosters.campaigns.get(row.campaign.id) ?? [])
        : row.gameDay
          ? (rosters.days.get(row.gameDay.id) ?? [])
          : [];
      const rosterSize = assigned.length;

      const tally = tallyOf(said, rosterSize);

      return {
        sessionId: row.session.id,
        title: sessionTitle(row.target),
        startsAt: row.session.startsAt,
        endsAt: row.session.endsAt,
        day: dayOf(row.session.startsAt, timeZone),
        dayLabel: dayLabelOf(row.session.startsAt, timeZone),
        state: row.session.state,
        location: row.session.location ?? row.gameDay?.venue ?? null,
        campaignId: row.session.campaignId,
        gameDayId: row.session.gameDayId,
        rosterSize,
        tally,
        // `quorumOf` is the same function the attendance post and `/upcoming`
        // render from, given the same rows. Nothing here re-derives it — and
        // "the same rows" now has to include the silence, because the veto rule
        // reads who is assigned and not only who answered. A page given the
        // answers alone would see a roster of however many people had clicked.
        quorum: quorumOf(row.target, rowsFor(said, assigned)),
        inJeopardy: row.session.state === "JEOPARDY",
      };
    }),
  };
}

/**
 * What a page is looking at when it asks for "what's next".
 *
 * A window rather than a count, because the agenda is a calendar and not a list
 * of ten — `/upcoming` is the one that cuts to ten, and it does it afterwards.
 */
export function windowAround(asOf: Date, days: number): { from: number; to: number } {
  const from = unix(asOf);
  return { from, to: from + days * 86_400 };
}

interface Said {
  userId: string;
  intent: "in" | "out" | "maybe" | null;
  note: string | null;
}

/**
 * The answers and the silence, in the shape `quorumOf` reads — the same set
 * `attendanceRows` builds for the post, assembled from a batched query instead of
 * one per session.
 *
 * The display name is the id: nothing on this path renders a name, and the rail
 * that does asks `session-detail` for it. A name fetched here would be a join per
 * row for a string thrown away.
 */
function rowsFor(said: Said[], assigned: string[]): AttendanceRow[] {
  const onRoster = new Set(assigned);
  const answered = said.map((row) => ({
    userId: row.userId,
    name: row.userId,
    intent: row.intent,
    note: row.note,
    onRoster: onRoster.has(row.userId),
  }));

  const heard = new Set(said.map((row) => row.userId));
  const silent = assigned
    .filter((userId) => !heard.has(userId))
    .map((userId) => ({ userId, name: userId, intent: null, note: null, onRoster: true }));

  return [...answered, ...silent];
}

function tallyOf(said: Said[], rosterSize: number): AgendaTally {
  const counted = (intent: Said["intent"]) => said.filter((row) => row.intent === intent).length;
  const heard = said.filter((row) => row.intent !== null).length;

  return {
    in: counted("in"),
    out: counted("out"),
    maybe: counted("maybe"),
    // Roster members Orrey has not heard from, floored at zero: somebody who
    // answered and then left the roster is still an answer, and would otherwise
    // make this negative.
    noReply: Math.max(0, rosterSize - heard),
  };
}

/** Every answer for every session on the list, in one query rather than one each. */
async function answersFor(env: Env, sessionIds: string[]): Promise<Map<string, Said[]>> {
  const rows = await db(env)
    .select({
      sessionId: schema.attendance.sessionId,
      userId: schema.attendance.userId,
      intent: schema.attendance.intent,
      note: schema.attendance.note,
    })
    .from(schema.attendance)
    .where(inArray(schema.attendance.sessionId, sessionIds))
    .all();

  const said = new Map<string, Said[]>();
  for (const row of rows) {
    const list = said.get(row.sessionId) ?? [];
    list.push({ userId: row.userId, intent: row.intent, note: row.note });
    said.set(row.sessionId, list);
  }
  return said;
}

/**
 * Who each roster holds.
 *
 * A campaign's is `campaign_members`; a game day's is its **seated** signups,
 * which is the same answer `attendanceRows` gives. Two grouped queries rather
 * than one per row.
 *
 * The ids and not a count, since `p8/1`: the veto rule has to know *which* people
 * are assigned to tell an objection from a seat that has been given up, and
 * `rosterSize` is `.length` of the same answer. One query cannot be wrong about
 * two things; two queries counting the same rows two ways eventually are.
 */
async function rosterMembers(env: Env, campaignIds: string[], gameDayIds: string[]) {
  const campaigns = new Map<string, string[]>();
  const days = new Map<string, string[]>();

  const push = (into: Map<string, string[]>, key: string, userId: string) => {
    const list = into.get(key) ?? [];
    list.push(userId);
    into.set(key, list);
  };

  if (campaignIds.length > 0) {
    const rows = await db(env)
      .select({
        campaignId: schema.campaignMembers.campaignId,
        userId: schema.campaignMembers.userId,
      })
      .from(schema.campaignMembers)
      .where(inArray(schema.campaignMembers.campaignId, campaignIds))
      .all();
    for (const row of rows) push(campaigns, row.campaignId, row.userId);
  }

  if (gameDayIds.length > 0) {
    const rows = await db(env)
      .select({ targetId: schema.signups.targetId, userId: schema.signups.userId })
      .from(schema.signups)
      .where(
        and(
          eq(schema.signups.targetType, "game_day"),
          eq(schema.signups.state, "in"),
          inArray(schema.signups.targetId, gameDayIds),
        ),
      )
      .all();
    for (const row of rows) push(days, row.targetId, row.userId);
  }

  return { campaigns, days };
}

/** `YYYY-MM-DD` in the guild's zone. `en-CA` is the locale that formats that way. */
export function dayOf(startsAt: number, timeZone: string): string {
  return new Date(startsAt * 1000).toLocaleDateString("en-CA", { timeZone });
}

/** `Saturday, 7 November` — what a day header says. */
export function dayLabelOf(startsAt: number, timeZone: string): string {
  return new Date(startsAt * 1000).toLocaleDateString("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone,
  });
}

function unix(date: Date): number {
  return Math.floor(date.getTime() / 1000);
}
