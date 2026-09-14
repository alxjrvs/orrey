import { and, eq, lte } from "drizzle-orm";
import type { Env } from "../env.ts";
import { db, schema } from "../db/index.ts";
import { enqueueProjection } from "../projection/outbox.ts";
import { surfacesFor } from "../campaigns/event-cap.ts";
import { postAttendancePost } from "../attendance/post.ts";
import { startSessionThread } from "../attendance/thread.ts";
import { postNoticeOnce } from "../attendance/notice.ts";
import { checkJeopardy } from "../attendance/jeopardy.ts";
import { assumeAttendance, registerRows } from "../attendance/assume.ts";
import { confirmedNotice, correctionPost } from "../attendance/render.ts";
import { loadProjectionTarget } from "../projection/target.ts";

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

      const messageId = await postAttendancePost(env, sessionId);
      // No post, no thread to hang off it. The job re-runs, and a post that
      // went up but was not recorded heals on the next drain — at which point
      // this runs too, because the thread is started from the *recorded* id
      // rather than from the one this call returned.
      if (!messageId) return;

      // Re-read: `postAttendancePost` has just written the message id, and the
      // thread hangs off it.
      const target = await loadProjectionTarget(env, sessionId);
      if (target) await startSessionThread(env, target);
      return;
    }

    /**
     * Quorum was reached. A short notice in the session's thread, posted once —
     * the claim under its own label is what makes "once" true, not this job
     * running once.
     */
    case "session.confirmed-notice": {
      const { sessionId } = job.payload as { sessionId?: string };
      if (!sessionId) throw new Error(`session.confirmed-notice job ${job.id} has no sessionId`);

      const target = await loadProjectionTarget(env, sessionId);
      // The session is gone, or it is no longer confirmed — a notice saying it
      // is on would be worse than no notice at all.
      if (!target || target.session.state !== "CONFIRMED") return;

      await postNoticeOnce(env, target, "confirmed", confirmedNotice(target));
      return;
    }

    /**
     * A day out: does it still run. It writes `sessions.state` and nothing else
     * — no notice here, and no cancellation ever. When the answer is no the
     * response is a date poll, which is phase 4's, so this marks the session and
     * leaves the deciding to people.
     */
    case "jeopardy.check": {
      const { sessionId } = job.payload as { sessionId?: string };
      if (!sessionId) throw new Error(`jeopardy.check job ${job.id} has no sessionId`);

      const target = await loadProjectionTarget(env, sessionId);
      if (!target) return;

      await checkJeopardy(env, target);
      return;
    }

    /**
     * It is over. Write the register from what people said, mark it as an
     * assumption, and mark the session PLAYED. The correction post is the PR
     * above this one.
     */
    case "attendance.assume": {
      const { sessionId } = job.payload as { sessionId?: string };
      if (!sessionId) throw new Error(`attendance.assume job ${job.id} has no sessionId`);

      const target = await loadProjectionTarget(env, sessionId);
      if (!target) return;

      const assumed = await assumeAttendance(env, target);
      // Nobody on the roster and nobody who clicked: there is no register to
      // correct, and a post with no buttons is a post that says nothing.
      if (assumed.length === 0) return;

      // Re-read rather than rendering `assumed`: an organiser who corrected a
      // row before this ran keeps their answer, and the post has to show it.
      await postNoticeOnce(
        env,
        target,
        "correction",
        correctionPost(target, await registerRows(env, sessionId), new Date()),
      );
      return;
    }

    // reminder.t-48h, reminder.t-24h, poll.close, horizon.extend — each added
    // in the phase that needs it.
    default:
      throw new Error(`unknown job kind: ${job.kind}`);
  }
}
