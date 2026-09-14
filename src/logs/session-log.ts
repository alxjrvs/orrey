import { asc, eq } from "drizzle-orm";
import type { Env } from "../env.ts";
import { db, schema } from "../db/index.ts";

/**
 * What was written down about a session, and the one way to write it.
 *
 * Both directions live here so that the two doors #46 asks for — the Discord
 * modal and the console form — are two callers of one function rather than two
 * implementations that drift.
 */
export interface SessionLog {
  id: number;
  sessionId: string;
  author: string;
  body: string;
  createdAt: number;
}

export async function addSessionLog(
  env: Env,
  entry: { sessionId: string; authorId: string; body: string },
): Promise<SessionLog | undefined> {
  const body = normaliseLogBody(entry.body);
  // Nothing to log is not an error and is not an empty row. A recap is appended,
  // never replaced, so there is no "clear it" to express.
  if (!body) return undefined;

  const [row] = await db(env)
    .insert(schema.sessionLogs)
    .values({ sessionId: entry.sessionId, author: entry.authorId, body })
    .returning();

  return row;
}

/**
 * One session's log, oldest first.
 *
 * Ordered on `created_at` and then on `id`, and the tie-break is the half that
 * matters: `created_at` is whole seconds, so two recaps written in the same
 * second sort equal, and `id` is monotonic precisely so that the order they come
 * back in is the order they were written.
 */
export function sessionLogs(env: Env, sessionId: string): Promise<SessionLog[]> {
  return db(env)
    .select()
    .from(schema.sessionLogs)
    .where(eq(schema.sessionLogs.sessionId, sessionId))
    .orderBy(asc(schema.sessionLogs.createdAt), asc(schema.sessionLogs.id))
    .all();
}

/**
 * The counterpart to `normaliseNote`, differing in the one way that matters:
 * **a recap keeps its newlines.**
 *
 * A note is rendered inline on a post Orrey can never edit, so a newline there
 * would break that post's layout permanently — `normaliseNote` collapses all
 * whitespace for that reason. A recap is a message of its own, and a paragraph
 * break is part of what somebody wrote.
 *
 * What it does take out: trailing whitespace on every line, runs of blank lines
 * beyond one, and leading and trailing blank space on the whole thing. Those are
 * artefacts of a text box, not of a writer.
 */
export function normaliseLogBody(body: string): string | null {
  const cleaned = body
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, 4000);

  return cleaned.length > 0 ? cleaned : null;
}
