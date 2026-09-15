import { eq, sql } from "drizzle-orm";
import type { Env } from "../env.ts";
import { db, schema } from "../db/index.ts";
import { forget } from "../projection/publications.ts";

/**
 * The available players, onto the new date.
 *
 * The last step of a move, and the thing Hermuz's surveys proved worth keeping:
 * somebody who has just said "Thursday works" should not have to say it again on
 * Thursday's post.
 *
 * **The old intents are cleared first.** They referred to the old date, and a
 * stale "out" about a Tuesday is not an answer about a Thursday — carrying it
 * over would be Orrey putting words in somebody's mouth. Only the people who
 * marked the winning date available get an answer written for them, because that
 * is the only thing they actually said.
 *
 * Notes survive the clear. A note is about the session, not about the date, and
 * "no car this month" is still true on Thursday.
 */
export async function carryOver(
  env: Env,
  sessionId: string,
  winningPollDateId: string,
): Promise<string[]> {
  const available = await db(env)
    .select({ userId: schema.pollResponses.userId })
    .from(schema.pollResponses)
    .where(eq(schema.pollResponses.pollDateId, winningPollDateId))
    .all();

  const d = db(env);
  // Every intent on this session, gone. An "out" about the old date goes too,
  // because it was about the old date.
  const clear = d
    .update(schema.attendance)
    .set({ intent: null, updatedAt: sql`(unixepoch())` })
    .where(eq(schema.attendance.sessionId, sessionId));

  const written = available.map((row) =>
    d
      .insert(schema.attendance)
      .values({ sessionId, userId: row.userId, intent: "in" })
      .onConflictDoUpdate({
        target: [schema.attendance.sessionId, schema.attendance.userId],
        // `intent` only. `attended` is the register's and nothing here may touch
        // it — a session that has not happened has nobody who came.
        set: { intent: "in", updatedAt: sql`(unixepoch())` },
      }),
  );

  /**
   * And forget the old post.
   *
   * This is a deliberate forget, not a reconcile: Orrey is not tracking two
   * posts, it is tracking the newest one. Clearing the id is what lets
   * `postAttendancePost` send a fresh one instead of returning the stored id —
   * and the old post stays clickable and stays correct, because it renders from
   * D1, so a click on it rewrites it to the new date.
   */
  const dropPostId = d
    .update(schema.sessions)
    .set({ discordMessageId: null, updatedAt: sql`(unixepoch())` })
    .where(eq(schema.sessions.id, sessionId));

  // One batch. Cleared intents without the answers written back is everybody
  // reading as "not heard from" on a date they already said yes to.
  await d.batch([clear, ...written, dropPostId]);

  // The ledger row has to go with the id, or the fresh post is refused by the
  // guard that exists to stop a *duplicate* post — which this is not. `forget`
  // rather than `retract`: the old post stays up and stays clickable, and Orrey
  // is deliberately no longer the thing that tracks it.
  await forget(env, { surface: "discord", kind: "message", targetId: sessionId });

  await db(env)
    .insert(schema.jobs)
    .values({
      id: `session.post-attendance:${sessionId}`,
      kind: "session.post-attendance",
      payload: { sessionId },
      idempotencyKey: `session.post-attendance:${sessionId}`,
      runAt: sql`(unixepoch())`,
    })
    .onConflictDoUpdate({
      target: schema.jobs.id,
      set: { runAt: sql`(unixepoch())`, state: "pending", attempts: 0, lastError: null },
    });

  return available.map((row) => row.userId);
}
