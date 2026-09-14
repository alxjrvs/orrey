import { asc, eq, inArray } from "drizzle-orm";
import type { Env } from "../env.ts";
import { db, schema } from "../db/index.ts";
import { sessionLogs, type SessionLog } from "../logs/session-log.ts";

/**
 * The read side of #46.
 *
 * `session_logs` holds the author's Discord id and nothing else about them,
 * because the id is the thing that is true for ever and the name is not. This
 * puts a name beside it by reading `users` — which `src/db/schema.ts` is
 * explicit about being a **cache**, so a row with no cached name renders as the
 * id rather than as an empty line. A log with a missing author is still a log.
 */
export interface LogEntry {
  id: number;
  sessionId: string;
  author: string;
  authorName: string;
  body: string;
  createdAt: number;
}

/** One session's log, oldest first, with names. */
export async function logsForSession(env: Env, sessionId: string): Promise<LogEntry[]> {
  return withNames(env, await sessionLogs(env, sessionId));
}

/**
 * A campaign's logs, grouped under the session each belongs to.
 *
 * Grouped rather than flat because a recap without its session is a paragraph
 * about nothing — the campaign page reads as a record of evenings, and the
 * evening is the unit. Sessions with no log at all are absent: a heading over
 * nothing is not history, it is a blank row.
 */
export interface SessionLogs {
  sessionId: string;
  number: number | null;
  startsAt: number;
  entries: LogEntry[];
}

export async function logsForCampaign(env: Env, campaignId: string): Promise<SessionLogs[]> {
  const sessions = await db(env)
    .select({
      id: schema.sessions.id,
      number: schema.sessions.number,
      startsAt: schema.sessions.startsAt,
    })
    .from(schema.sessions)
    .where(eq(schema.sessions.campaignId, campaignId))
    .orderBy(asc(schema.sessions.startsAt))
    .all();

  if (sessions.length === 0) return [];

  // One statement for every session's logs rather than one per session. D1 caps
  // a statement at a hundred bound parameters, so a campaign with more sessions
  // than that is read a page at a time.
  const rows: SessionLog[] = [];
  const ids = sessions.map((session) => session.id);
  for (let from = 0; from < ids.length; from += 90) {
    rows.push(
      ...(await db(env)
        .select()
        .from(schema.sessionLogs)
        .where(inArray(schema.sessionLogs.sessionId, ids.slice(from, from + 90)))
        .orderBy(asc(schema.sessionLogs.createdAt), asc(schema.sessionLogs.id))
        .all()),
    );
  }

  const named = await withNames(env, rows);
  const by = new Map<string, LogEntry[]>();
  for (const entry of named) {
    const bucket = by.get(entry.sessionId);
    if (bucket) bucket.push(entry);
    else by.set(entry.sessionId, [entry]);
  }

  return sessions
    .filter((session) => by.has(session.id))
    .map((session) => ({
      sessionId: session.id,
      number: session.number,
      startsAt: session.startsAt,
      entries: by.get(session.id) as LogEntry[],
    }));
}

async function withNames(env: Env, rows: SessionLog[]): Promise<LogEntry[]> {
  if (rows.length === 0) return [];

  const authors = [...new Set(rows.map((row) => row.author))];
  const names = new Map<string, string>();
  for (let from = 0; from < authors.length; from += 90) {
    const people = await db(env)
      .select({
        discordId: schema.users.discordId,
        username: schema.users.username,
        globalName: schema.users.globalName,
      })
      .from(schema.users)
      .where(inArray(schema.users.discordId, authors.slice(from, from + 90)))
      .all();
    for (const person of people) {
      names.set(person.discordId, person.globalName ?? person.username ?? person.discordId);
    }
  }

  return rows.map((row) => ({
    ...row,
    // The id, not a blank. A cache that has not caught up is not an anonymous
    // author.
    authorName: names.get(row.author) ?? row.author,
  }));
}
