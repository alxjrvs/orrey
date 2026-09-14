import { and, eq, lte } from "drizzle-orm";
import type { Env } from "../env.ts";
import { db, schema } from "../db/index.ts";
import { enqueueProjection } from "../projection/outbox.ts";
import { surfacesFor } from "../campaigns/event-cap.ts";
import { postAttendancePost } from "../attendance/post.ts";

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

async function runJob(job: typeof schema.jobs.$inferSelect, env: Env): Promise<void> {
  switch (job.kind) {
    /**
     * The bridge from D1 to the outbox. A session is created or changed in the
     * database — by the seed in phase 1, by the console and the materialiser
     * later — and the row that says "this needs projecting" is a job, not a
     * queue message, so it can be seen, re-armed and re-run.
     */
    case "session.project": {
      const { sessionId } = job.payload as { sessionId?: string };
      if (!sessionId) throw new Error(`session.project job ${job.id} has no sessionId`);
      // Google always; Discord only while this session is one of its campaign's
      // next two. A scheduled event further out than that is a slot spent on
      // something nobody is looking at yet.
      await enqueueProjection(env, sessionId, await surfacesFor(env, sessionId, new Date()));
      return;
    }

    /**
     * The attendance post, sent once. Send-only: this job records the message
     * id and never touches the message again — a re-run finds the id and does
     * nothing rather than posting a second one.
     */
    case "session.post-attendance": {
      const { sessionId } = job.payload as { sessionId?: string };
      if (!sessionId) throw new Error(`session.post-attendance job ${job.id} has no sessionId`);
      await postAttendancePost(env, sessionId);
      return;
    }

    // reminder.t-48h, reminder.t-24h, jeopardy.check, attendance.assume,
    // poll.close, horizon.extend — each added in the phase that needs it.
    default:
      throw new Error(`unknown job kind: ${job.kind}`);
  }
}
