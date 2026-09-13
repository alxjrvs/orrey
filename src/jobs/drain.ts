import { and, eq, lte } from "drizzle-orm";
import type { Env } from "../env.ts";
import { db, schema } from "../db/index.ts";

const CLAIM_SECONDS = 60;
const BATCH = 25;

/**
 * Runs every minute. Claims due jobs with a lease so a slow run and the next
 * tick cannot both execute the same job, then dispatches each one.
 */
export async function drainJobs(env: Env): Promise<number> {
  const d = db(env);
  const now = Math.floor(Date.now() / 1000);

  const due = await d
    .select()
    .from(schema.jobs)
    .where(and(eq(schema.jobs.state, "pending"), lte(schema.jobs.runAt, now)))
    .limit(BATCH);

  let ran = 0;
  for (const job of due) {
    const claimed = await d
      .update(schema.jobs)
      .set({ state: "claimed", claimedUntil: now + CLAIM_SECONDS, attempts: job.attempts + 1 })
      .where(and(eq(schema.jobs.id, job.id), eq(schema.jobs.state, "pending")))
      .returning({ id: schema.jobs.id });
    if (claimed.length === 0) continue;

    try {
      await runJob(job, env);
      await d.update(schema.jobs).set({ state: "done" }).where(eq(schema.jobs.id, job.id));
      ran++;
    } catch (error) {
      await d
        .update(schema.jobs)
        .set({ state: "pending", lastError: String(error), runAt: now + 60 * job.attempts })
        .where(eq(schema.jobs.id, job.id));
    }
  }
  return ran;
}

async function runJob(job: typeof schema.jobs.$inferSelect, _env: Env): Promise<void> {
  switch (job.kind) {
    // reminder.t-48h, reminder.t-24h, jeopardy.check, attendance.assume,
    // poll.close, horizon.extend — each added in the phase that needs it.
    default:
      throw new Error(`unknown job kind: ${job.kind}`);
  }
}
