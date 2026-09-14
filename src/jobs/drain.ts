import { and, eq, lte, or, sql } from "drizzle-orm";
import type { Env } from "../env.ts";
import { db, schema } from "../db/index.ts";
import { enqueueProjection, enqueueUnprojection } from "../projection/outbox.ts";
import { surfacesFor } from "../campaigns/event-cap.ts";
import { postAttendancePost } from "../attendance/post.ts";
import { startSessionThread } from "../attendance/thread.ts";
import { postNoticeOnce } from "../attendance/notice.ts";
import { checkJeopardy } from "../attendance/jeopardy.ts";
import { sendReminder } from "../attendance/reminders.ts";
import { assumeAttendance, registerRows } from "../attendance/assume.ts";
import { gmOf } from "../campaigns/roster.ts";
import { attendanceRows } from "../attendance/rows.ts";
import { requiredFor } from "../attendance/quorum.ts";
import { confirmedNotice, correctionPost, jeopardyNotice } from "../attendance/render.ts";
import { isMultiDaySession } from "../attendance/tables.ts";
import { announceGameDay, postCloseNotice, postPollPost } from "../polls/post.ts";
import { APPLY_JOB, applyFollowUp } from "../polls/canonise.ts";
import { POST_SIGNUP_JOB, postSignupPost, startDayThread } from "../game-days/post.ts";
import { sessionIdFor } from "../game-days/lifecycle.ts";
import { SYNC_JOB, runSync } from "../google/sync.ts";
import { PROMOTED_JOB } from "../game-days/promote.ts";
import {
  CANCELLED_JOB,
  LOCK_JOB,
  cancelledNotice,
  lockIfSeating,
  playAfterAssume,
} from "../game-days/lifecycle.ts";
import { postDayNoticeOnce, promotedNotice } from "../game-days/notice.ts";
import { loadProjectionTarget } from "../projection/target.ts";

const CLAIM_SECONDS = 60;
const BATCH = 25;

/**
 * A job this drain is allowed to take: one nobody holds, or one whose lease has
 * run out.
 *
 * The second half is what makes `claimed_until` mean anything. It was written
 * and never read, so a job whose isolate died mid-run — a cron invocation
 * evicted, a CPU limit — stayed `claimed` for ever and no later drain would look
 * at it again. The lease was a lease nobody collected.
 *
 * Phase 5 is what makes that bite. A `game-day.lock` job that dies leaves the
 * day in SEATING through its own evening, and a `game-day.post-signup` job that
 * dies leaves a SEATING day with no post anybody can claim a seat on.
 *
 * The same expression guards the claim's `where`, and that is what keeps
 * exactly-once per lease: the drain that wins sets `claimed_until` forward, so a
 * concurrent drain's compare-and-set matches nothing.
 */
function reclaimable(now: number) {
  return or(
    eq(schema.jobs.state, "pending"),
    and(eq(schema.jobs.state, "claimed"), lte(schema.jobs.claimedUntil, now)),
  );
}

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
    .where(and(reclaimable(now), lte(schema.jobs.runAt, now)))
    .limit(BATCH);

  let ran = 0;
  for (const job of due) {
    const claimed = await d
      .update(schema.jobs)
      .set({ state: "claimed", claimedUntil: now + CLAIM_SECONDS, attempts: job.attempts + 1 })
      .where(and(eq(schema.jobs.id, job.id), reclaimable(now)))
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

      const outcome = await checkJeopardy(env, target);
      // Only the session that actually fell short gets a notice. The other three
      // outcomes are "nothing to say", and a notice asking whether a confirmed
      // session is happening is worse than silence.
      if (outcome !== "in-jeopardy") return;

      const required = requiredFor(target);
      if (required == null) return;

      await postNoticeOnce(
        env,
        target,
        "jeopardy",
        jeopardyNotice({
          target,
          rows: await attendanceRows(env, sessionId),
          gmId: target.campaign ? await gmOf(env, target.campaign.id) : undefined,
          required,
          asOf: new Date(),
        }),
      );
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

      // A game day's evening is over, so the day is too. This happens before the
      // early return below, because a day nobody claimed a seat at is still a
      // day that has been and gone.
      if (target.session.gameDayId) await playAfterAssume(env, target.session.gameDayId);
      // Nobody on the roster and nobody who clicked: there is no register to
      // correct, and a post with no buttons is a post that says nothing.
      if (assumed.length === 0) return;

      // Re-read rather than rendering `assumed`: an organiser who corrected a
      // row before this ran keeps their answer, and the post has to show it.
      await postNoticeOnce(
        env,
        target,
        "correction",
        correctionPost(target, await registerRows(env, sessionId), new Date(), {
          // The button is a multi day's alone. A campaign session and a single
          // day both play one thing, and asking what somebody played would be a
          // question with one answer.
          multiDay: await isMultiDaySession(env, sessionId),
        }),
      );
      return;
    }

    /**
     * One rung of the ladder. A DM to everybody who has not answered, and one
     * shared message in the thread for everybody whose DMs are shut.
     */
    case "reminder.step": {
      const { sessionId, hours } = job.payload as { sessionId?: string; hours?: number };
      if (!sessionId) throw new Error(`reminder.step job ${job.id} has no sessionId`);
      if (hours === undefined) throw new Error(`reminder.step job ${job.id} has no hours`);

      const target = await loadProjectionTarget(env, sessionId);
      if (!target) return;

      await sendReminder(env, target, hours);
      return;
    }

    /**
     * Put the poll up. Guarded by the recorded message id rather than by the
     * job, so a redelivery cannot produce a second post with a second live
     * select.
     */
    case "poll.post": {
      const { pollId } = job.payload as { pollId?: string };
      if (!pollId) throw new Error(`poll.post job ${job.id} has no pollId`);

      await postPollPost(env, pollId);
      return;
    }

    /**
     * Answering has stopped. Post a notice saying where the tallies landed —
     * the poll post cannot be disarmed and cannot say so itself, and under
     * send-only there is nothing to edit. The select is refused by the handler
     * from here on.
     */
    case "poll.close": {
      const { pollId } = job.payload as { pollId?: string };
      if (!pollId) throw new Error(`poll.close job ${job.id} has no pollId`);

      await postCloseNotice(env, pollId);
      return;
    }

    /**
     * A day exists. One new message in the scheduling channel saying so — never
     * an edit, and its id is not stored, because nothing will reconcile it.
     */
    case "gameday.announce": {
      const { gameDayId } = job.payload as { gameDayId?: string };
      if (!gameDayId) throw new Error(`gameday.announce job ${job.id} has no gameDayId`);

      await announceGameDay(env, gameDayId);
      return;
    }

    /**
     * What closing a poll set in motion.
     *
     * Armed in the same batch as the close, so "this poll is closed" and "the
     * move it decided on is owed" are one fact rather than two that a refused
     * Discord call can pull apart. Retried with backoff like every other job,
     * and written to be retried: the move re-arms with upserts and posts its
     * notice under a claim.
     */
    case APPLY_JOB: {
      const { pollId, sessionId, wasStartsAt } = job.payload as {
        pollId?: string;
        sessionId?: string;
        wasStartsAt?: number;
      };
      if (!pollId) throw new Error(`${APPLY_JOB} job ${job.id} has no pollId`);
      if (!sessionId) return;

      await applyFollowUp(env, pollId, sessionId, wasStartsAt);
      return;
    }

    /**
     * The seating stage's post, sent once, and the thread that hangs off it.
     *
     * Send-only, like the attendance post: this records the message id and never
     * touches the message again — a re-run finds the id and does nothing rather
     * than posting a second one with live buttons.
     *
     * Nothing arms this yet. `PROPOSED → SEATING` is `p5/9`'s, and it is defined
     * as "post the signup post", so the transition and this handler have to be
     * on the same side of a merge: a transition landing first would arm a job
     * `runJob` throws on, which sends it back to `pending` with a growing
     * backoff until the PR above it lands.
     */
    case POST_SIGNUP_JOB: {
      const { gameDayId } = job.payload as { gameDayId?: string };
      if (!gameDayId) throw new Error(`game-day.post-signup job ${job.id} has no gameDayId`);

      const messageId = await postSignupPost(env, gameDayId);
      // No post, no thread to hang off it. The job re-runs, and a post that went
      // up but was not recorded heals on the next drain — at which point the
      // thread is started from the *recorded* id rather than this call's.
      if (!messageId) return;

      const threadId = await startDayThread(env, gameDayId);
      if (!threadId) return;

      // And now the attendance post, once the day has a thread to put it in.
      //
      // It is armed here rather than by the transition that armed this job
      // because `postAttendancePost` sends into the day's thread if there is
      // one and into the channel if there is not, and under send-only a post in
      // the wrong place cannot be moved. Arming it a minute out would be a race
      // this loses whenever the signup post has to retry; arming it from the
      // thread's own creation cannot be. `onConflictDoNothing` because this
      // job's own retry runs it again.
      //
      // Without it a game day has no surface anybody can say "I'm coming" on,
      // and `attendance.assume` writes the whole seated table down as absent.
      await db(env)
        .insert(schema.jobs)
        .values({
          id: `session.post-attendance:${sessionIdFor(gameDayId)}`,
          kind: "session.post-attendance",
          payload: { sessionId: sessionIdFor(gameDayId) },
          idempotencyKey: `session.post-attendance:${sessionIdFor(gameDayId)}`,
          runAt: sql`(unixepoch())`,
        })
        .onConflictDoNothing();
      return;
    }

    /**
     * Somebody came off the waitlist. One new message in the day's thread saying
     * so, addressed to them — never a rewrite of the signup post, because
     * anything changing from outside posts a new message.
     *
     * The job carries who moved: by the time this runs they are simply seated,
     * and indistinguishable from everybody else at the table.
     */
    case PROMOTED_JOB: {
      const { gameDayId, noticeId, userIds } = job.payload as {
        gameDayId?: string;
        noticeId?: string;
        userIds?: string[];
      };
      if (!gameDayId) throw new Error(`${PROMOTED_JOB} job ${job.id} has no gameDayId`);
      if (!userIds?.length) return;

      const row = await db(env)
        .select({ day: schema.gameDays, game: schema.games })
        .from(schema.gameDays)
        .leftJoin(schema.games, eq(schema.gameDays.gameId, schema.games.id))
        .where(eq(schema.gameDays.id, gameDayId))
        .get();
      // The day is gone, or it was called off between the promotion and this —
      // and a message saying "you're in" about a day nobody is running is worse
      // than no message at all.
      if (!row || row.day.state === "CANCELLED") return;

      await postDayNoticeOnce(
        env,
        gameDayId,
        `promoted:${noticeId ?? userIds.join(",")}`,
        promotedNotice(row.day, row.game, userIds),
      );
      return;
    }

    /**
     * The table settles. A fallback for the day nobody locked by hand, which is
     * why it is written to be harmless on one that is already locked, played or
     * called off rather than throwing on the ordinary case.
     *
     * It posts nothing. The signup post's buttons outlive the lock — a post is
     * never edited — and the `seat` handler is what tells a late clicker what
     * happened, ephemerally, leaving the post alone.
     */
    case LOCK_JOB: {
      const { gameDayId } = job.payload as { gameDayId?: string };
      if (!gameDayId) throw new Error(`${LOCK_JOB} job ${job.id} has no gameDayId`);

      await lockIfSeating(env, gameDayId);
      return;
    }

    /**
     * The day is off. One new message in its thread, claimed under its own label
     * so a second cancellation posts nothing.
     *
     * The deletes went out with the transition itself — they are queue messages
     * rather than work for here, and `project`'s retract branch is deliberately
     * ungated so a cancelled day's event comes down rather than being stranded.
     */
    case CANCELLED_JOB: {
      const { gameDayId } = job.payload as { gameDayId?: string };
      if (!gameDayId) throw new Error(`${CANCELLED_JOB} job ${job.id} has no gameDayId`);

      // Both surfaces come down, and from here rather than from `transition`,
      // so the deletes are owed by the same durable row that owes the notice. A
      // queue that is down sends this job back to `pending` with a backoff
      // instead of losing the retraction for good — cancelling is terminal and
      // there is no second click that reaches the transition again.
      //
      // Not gated on the day still being projectable: a delete is how something
      // published comes down, and `project`'s retract branch is deliberately
      // ungated for exactly this, no-ops on a session with no event ids, and is
      // written so that projecting twice is indistinct from projecting once. So
      // a re-run after a refused post costs nothing.
      await enqueueUnprojection(env, sessionIdFor(gameDayId));

      const row = await db(env)
        .select({ day: schema.gameDays, game: schema.games })
        .from(schema.gameDays)
        .leftJoin(schema.games, eq(schema.gameDays.gameId, schema.games.id))
        .where(eq(schema.gameDays.id, gameDayId))
        .get();
      if (!row) return;

      await postDayNoticeOnce(env, gameDayId, "cancelled", cancelledNotice(row.day, row.game));
      return;
    }

    case SYNC_JOB: {
      // Google says something on the calendar changed. What changed is whatever
      // the list call says changed — the push carried no body and this job
      // holds none either, only the minute it collapsed a burst into.
      //
      // Lists and classifies; acting on a verdict is the PR above.
      await runSync(env);
      return;
    }

    // horizon.extend — added in the phase that needs it.
    default:
      throw new Error(`unknown job kind: ${job.kind}`);
  }
}
