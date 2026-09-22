import { and, eq, inArray } from "drizzle-orm";
import type { Env } from "../env.ts";
import { db, schema } from "../db/index.ts";
import { quorumOf } from "../attendance/quorum.ts";
import type { Quorum } from "../attendance/quorum.ts";
import { agendaBetween, windowAround } from "../console/agenda.ts";

/**
 * The agenda: everything on the calendar, for you, right now.
 *
 * **One list, not four.** Ordered by when it starts across every campaign the
 * caller is on rather than grouped by campaign, because the question is "what is
 * my week" and a person in three campaigns reading three lists has to do the
 * merge in their head.
 *
 * Ephemeral and read from D1 at the moment it is asked. A post is a snapshot and
 * this deliberately is not one — that is the whole reason the command exists.
 */
const HOW_MANY = 10;

export interface UpcomingEntry {
  sessionId: string;
  title: string;
  startsAt: number;
  state: "SCHEDULED" | "CONFIRMED" | "JEOPARDY";
  quorum: Quorum;
  /** What the caller themselves said. Null is "not heard from", which is the point. */
  mine: "in" | "out" | "maybe" | null;
}

export interface Upcoming {
  entries: UpcomingEntry[];
  /** How many there were before the list was cut to `HOW_MANY`. */
  total: number;
}

export async function upcomingFor(env: Env, userId: string, asOf: Date): Promise<UpcomingEntry[]> {
  return (await upcomingWithTotal(env, userId, asOf)).entries;
}

/**
 * A year. `/upcoming` shows ten, and the horizon only has to be wide enough that
 * the ten it shows are the right ten — the materialiser keeps four sessions per
 * campaign ahead, so a year is already far past anything that exists.
 */
const HORIZON_DAYS = 365;

export async function upcomingWithTotal(
  env: Env,
  userId: string,
  asOf: Date,
): Promise<Upcoming> {
  const mine = await campaignsOf(env, userId);
  if (mine.size === 0) return { entries: [], total: 0 };

  /**
   * The numbers come from the agenda model rather than from a second query here.
   *
   * #43 calls the console's agenda "the counterpart to `/upcoming`", and a
   * counterpart that counts the same things a second way is one that disagrees
   * with the first by the phase after next. So there is one window query, one
   * roster count and one `quorumOf`, and this is a caller of it.
   *
   * It also picks up the model's rule that a campaign which is not RUNNING
   * contributes nothing: a session Orrey is not putting on anybody's calendar is
   * not one to put on somebody's agenda either.
   */
  const { from, to } = windowAround(asOf, HORIZON_DAYS);
  const { rows } = await agendaBetween(env, from, to, asOf);

  // A session that has been called off is not on anybody's agenda, and one that
  // has been played is history — both excluded by state rather than by time,
  // because a session cancelled for next Tuesday is still in the future.
  const ours = rows.filter(
    (row) =>
      row.campaignId !== null &&
      mine.has(row.campaignId) &&
      row.state !== "CANCELLED" &&
      row.state !== "PLAYED",
  );

  const wanted = ours.slice(0, HOW_MANY);
  if (wanted.length === 0) return { entries: [], total: 0 };

  // The one thing the agenda cannot answer, because it is nobody's in
  // particular: what *this* caller said.
  const said = await intentsOf(
    env,
    userId,
    wanted.map((row) => row.sessionId),
  );

  return {
    entries: wanted.map((row) => ({
      sessionId: row.sessionId,
      title: row.title,
      startsAt: row.startsAt,
      state: row.state as UpcomingEntry["state"],
      quorum: row.quorum,
      mine: said.get(row.sessionId) ?? null,
    })),
    total: ours.length,
  };
}

/** The campaigns this person is on. Membership is the whole of "yours". */
async function campaignsOf(env: Env, userId: string): Promise<Set<string>> {
  const rows = await db(env)
    .select({ campaignId: schema.campaignMembers.campaignId })
    .from(schema.campaignMembers)
    .where(eq(schema.campaignMembers.userId, userId))
    .all();
  return new Set(rows.map((row) => row.campaignId));
}

async function intentsOf(
  env: Env,
  userId: string,
  sessionIds: string[],
): Promise<Map<string, "in" | "out" | "maybe" | null>> {
  const rows = await db(env)
    .select({ sessionId: schema.attendance.sessionId, intent: schema.attendance.intent })
    .from(schema.attendance)
    .where(
      and(
        eq(schema.attendance.userId, userId),
        inArray(schema.attendance.sessionId, sessionIds),
      ),
    )
    .all();

  return new Map(rows.map((row) => [row.sessionId, row.intent]));
}

/**
 * What the caller reads.
 *
 * Every time is a Discord timestamp rather than a rendered date: `<t:…:F>`
 * renders in the reader's own zone, which is the only way one line can be right
 * for a table spread over three of them. Orrey never renders a wall-clock time
 * into a message it cannot take back.
 */
export function renderUpcoming(entries: UpcomingEntry[], asOf: Date, total?: number): string {
  if (entries.length === 0) {
    return [
      "**Nothing upcoming.**",
      "Nothing on your rosters has a session scheduled. That is the answer, not an error —",
      "if you expected something here, the campaign may not have materialised it yet.",
    ].join("\n");
  }

  const lines = entries.map((entry) => `- ${line(entry)}`);
  // The heading is the caller's total, not the length of a list this function
  // silently cut. Saying "six sessions" over a list of six when there are eleven
  // is a wrong answer to the question the command asks.
  const shown = total ?? entries.length;
  const dropped = shown - entries.length;

  return [
    `**Upcoming — ${shown} ${shown === 1 ? "session" : "sessions"}**`,
    ...lines,
    ...(dropped > 0 ? [`-# ${dropped} more beyond these. Ask again nearer the time.`] : []),
    `-# As of <t:${Math.floor(asOf.getTime() / 1000)}:t>. Read fresh every time you ask.`,
  ].join("\n");
}

function line(entry: UpcomingEntry): string {
  const parts = [`<t:${entry.startsAt}:F> — **${entry.title}**`];

  const standing = standingOf(entry);
  if (standing) parts.push(standing);
  parts.push(mineOf(entry.mine));

  return parts.join(" · ");
}

/** Does it run — the same answers the post gives, in one phrase. */
function standingOf(entry: UpcomingEntry): string | undefined {
  const { rule, required, saidIn, slipped, vetoes, roster } = entry.quorum;

  /**
   * Under the veto rule there is no tally worth printing, so the phrase is the
   * standing itself. "3 of 5 in" over a session that is going ahead is the reading
   * this phase exists to stop, and `/upcoming` is where somebody skims six of
   * them at once — the line that says "on" has to mean it.
   */
  if (rule === "unanimous") {
    if (vetoes.length === 0) return "on";
    const who = vetoes.length === 1 ? "1 person" : `${vetoes.length} people`;
    return `moving — ${who} of ${roster} out`;
  }

  if (entry.state === "JEOPARDY") {
    return required === null ? "in jeopardy" : `in jeopardy — ${saidIn} of ${required} in`;
  }
  if (slipped) return `confirmed, ${saidIn} of ${required} in now`;
  if (entry.state === "CONFIRMED") return "confirmed";
  if (required === null) return undefined;

  // Short by n rather than "n of m": the useful number is how many more it
  // takes, and that is the number somebody can do something about.
  const short = required - saidIn;
  return short > 0 ? `short by ${short}` : `${saidIn} of ${required} in`;
}

function mineOf(mine: UpcomingEntry["mine"]): string {
  switch (mine) {
    case "in":
      return "you: in";
    case "out":
      return "you: out";
    case "maybe":
      return "you: maybe";
    default:
      return "**you have not said**";
  }
}
