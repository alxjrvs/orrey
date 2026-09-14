import { and, asc, eq, gte, inArray, ne } from "drizzle-orm";
import type { Env } from "../env.ts";
import { db, schema } from "../db/index.ts";
import { quorumOf } from "../attendance/quorum.ts";
import type { Quorum } from "../attendance/quorum.ts";
import { sessionTitle } from "../projection/target.ts";

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

export async function upcomingFor(
  env: Env,
  userId: string,
  asOf: Date,
): Promise<UpcomingEntry[]> {
  const now = Math.floor(asOf.getTime() / 1000);

  // The caller's campaigns, and the sessions of those still to come. A session
  // that has been called off is not on anybody's agenda, and one that has been
  // played is history — both are excluded by state rather than by time, because
  // a session cancelled for next Tuesday is still in the future.
  const rows = await db(env)
    .select({ session: schema.sessions, campaign: schema.campaigns })
    .from(schema.campaignMembers)
    .innerJoin(schema.campaigns, eq(schema.campaigns.id, schema.campaignMembers.campaignId))
    .innerJoin(schema.sessions, eq(schema.sessions.campaignId, schema.campaigns.id))
    .where(
      and(
        eq(schema.campaignMembers.userId, userId),
        gte(schema.sessions.startsAt, now),
        ne(schema.sessions.state, "CANCELLED"),
        ne(schema.sessions.state, "PLAYED"),
      ),
    )
    .orderBy(asc(schema.sessions.startsAt), asc(schema.sessions.id))
    .all();

  const wanted = rows.slice(0, HOW_MANY);
  if (wanted.length === 0) return [];

  // One query for every register row of every session on the list, rather than
  // one query per session. Quorum is a count of `in`, so this is all it needs.
  const attendance = await db(env)
    .select({
      sessionId: schema.attendance.sessionId,
      userId: schema.attendance.userId,
      intent: schema.attendance.intent,
    })
    .from(schema.attendance)
    .where(
      inArray(
        schema.attendance.sessionId,
        wanted.map((row) => row.session.id),
      ),
    )
    .all();

  return wanted.map(({ session, campaign }) => {
    const rowsForSession = attendance
      .filter((row) => row.sessionId === session.id)
      .map((row) => ({ userId: row.userId, name: row.userId, intent: row.intent, note: null }));

    return {
      sessionId: session.id,
      title: sessionTitle({ session, campaign }),
      startsAt: session.startsAt,
      state: session.state as UpcomingEntry["state"],
      quorum: quorumOf({ session, campaign }, rowsForSession),
      mine: rowsForSession.find((row) => row.userId === userId)?.intent ?? null,
    };
  });
}

/**
 * What the caller reads.
 *
 * Every time is a Discord timestamp rather than a rendered date: `<t:…:F>`
 * renders in the reader's own zone, which is the only way one line can be right
 * for a table spread over three of them. Orrey never renders a wall-clock time
 * into a message it cannot take back.
 */
export function renderUpcoming(entries: UpcomingEntry[], asOf: Date): string {
  if (entries.length === 0) {
    return [
      "**Nothing upcoming.**",
      "Nothing on your rosters has a session scheduled. That is the answer, not an error —",
      "if you expected something here, the campaign may not have materialised it yet.",
    ].join("\n");
  }

  const lines = entries.map((entry) => `- ${line(entry)}`);
  return [
    `**Upcoming — ${entries.length} ${entries.length === 1 ? "session" : "sessions"}**`,
    ...lines,
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

/** Does it run — the same three answers the post gives, in one phrase. */
function standingOf(entry: UpcomingEntry): string | undefined {
  const { required, saidIn, slipped } = entry.quorum;

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
