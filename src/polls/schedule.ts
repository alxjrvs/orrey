import { eq, sql } from "drizzle-orm";
import type { Env } from "../env.ts";
import { db, schema } from "../db/index.ts";

/**
 * When answering stops.
 *
 * A `jobs` row in D1 rather than a queue message, like every other timed thing
 * in Orrey: it can be looked at, cancelled and re-run, which a queue message
 * cannot. One standing row per poll, re-armed rather than duplicated, so moving
 * a poll's deadline moves the job instead of making a second one.
 */
export const CLOSE_JOB = "poll.close";

export async function armPollClose(env: Env, pollId: string, closesAt: number): Promise<void> {
  const id = `${CLOSE_JOB}:${pollId}`;
  await db(env)
    .insert(schema.jobs)
    .values({ id, kind: CLOSE_JOB, payload: { pollId }, idempotencyKey: id, runAt: closesAt })
    .onConflictDoUpdate({
      target: schema.jobs.id,
      // A check still pointing at the old time would fire on the wrong day, and
      // a failed one that is never un-failed never fires at all.
      set: { runAt: closesAt, state: "pending", attempts: 0, lastError: null },
    });

  await db(env)
    .update(schema.datePolls)
    .set({ closesAt, updatedAt: sql`(unixepoch())` })
    .where(eq(schema.datePolls.id, pollId));
}
