import { and, eq, inArray, sql } from "drizzle-orm";
import type { Env } from "../env.ts";
import { db, schema } from "../db/index.ts";
import { rearm, type ArmedJob } from "../jobs/arm.ts";
import { SETTING_DEFAULTS, SETTING_KEYS, settingOr } from "../db/settings.ts";
import { attendanceRows } from "./rows.ts";
import { quorumOf } from "./quorum.ts";
import type { ProjectionTarget } from "../projection/target.ts";

/**
 * Does it still run.
 *
 * Time-triggered state changes were the only real casualty of send-only: a
 * session quietly falling short at midnight cannot reach into yesterday's post
 * and say so. So the answer is a *state* the clock may write and a *notice* it
 * may post, and neither of them touches the attendance post.
 *
 * This is the state half. The notice is the PR above.
 */
export const JEOPARDY_JOB = "jeopardy.check";

/**
 * One standing job per session, re-armed rather than duplicated. Phase 4 moves a
 * session with a date poll, and a check still pointing at the old time would
 * fire a day after the wrong day — so the id is derived and re-arming is an
 * upsert that moves `run_at`.
 */
/**
 * The row, described. The lead time is a settings read, so this is async even
 * though nothing is written — a caller batching it with a state write needs the
 * read done *before* the batch, which is the point.
 */
export async function jeopardyJob(
  env: Env,
  sessionId: string,
  startsAt: number,
): Promise<ArmedJob> {
  const leadHours = await settingOr(
    env,
    SETTING_KEYS.jeopardyLeadHours,
    SETTING_DEFAULTS["jeopardy.lead_hours"],
  );
  return {
    id: `${JEOPARDY_JOB}:${sessionId}`,
    kind: JEOPARDY_JOB,
    payload: { sessionId },
    runAt: startsAt - leadHours * 3600,
  };
}

export async function armJeopardyCheck(
  env: Env,
  sessionId: string,
  startsAt: number,
): Promise<void> {
  // A moved session is a moved check: pending again, at the new time, with the
  // old failure forgotten.
  await rearm(db(env), [await jeopardyJob(env, sessionId, startsAt)]);
}

export type JeopardyOutcome = "confirmed" | "in-jeopardy" | "no-quorum-set" | "not-waiting";

/**
 * What the check found. It writes `sessions.state` and nothing else — no notice,
 * no cancellation. #29 is explicit that when the answer is no the response is a
 * date poll rather than a cancellation, so this marks the session and leaves the
 * deciding to people.
 *
 * `in-jeopardy` means two different things now and deliberately keeps one name:
 * short of a quorum, or vetoed by somebody on the roster. Both are "this will not
 * run as it stands", both are written as JEOPARDY, and the notice above this reads
 * the verdict itself to say which — an outcome per rule would be a second place
 * that has to know what the rules are.
 */
export async function checkJeopardy(
  env: Env,
  target: ProjectionTarget,
): Promise<JeopardyOutcome> {
  const { session } = target;

  // Already confirmed, already cancelled, already played. None of these is a
  // session waiting to find out whether it runs.
  //
  // **JEOPARDY is not one of them.** A session already marked short is one this
  // check has run on before — and the run that marked it may well have failed to
  // post the notice afterwards. Answering "not-waiting" here made the state
  // write the thing that enforced "once", so a single refused Discord call lost
  // the notice for ever: the retry could never reach the post again. The claim
  // in `postNoticeOnce` is what makes it once; this only has to be honest about
  // what it found.
  if (session.state !== "SCHEDULED" && session.state !== "JEOPARDY") {
    return session.state === "CONFIRMED" ? "confirmed" : "not-waiting";
  }

  const quorum = quorumOf(target, await attendanceRows(env, session.id));

  /**
   * A campaign that never said what quorum is has not asked this question, and
   * Orrey does not get to answer it on their behalf.
   *
   * Only under the counting rule. Under the veto rule there is no number to be
   * short of and none missing — `met` is "nobody assigned to this has said they
   * cannot make it", which is a question the clock can answer on its own, and the
   * one this check exists to ask a day out. Reading `required` first is what made
   * a rostered campaign answer `no-quorum-set` to a session somebody had already
   * vetoed.
   */
  if (quorum.rule === "quorum" && quorum.required === null) return "no-quorum-set";
  if (quorum.met) return "confirmed";

  /**
   * Guarded on the state this read saw.
   *
   * This is a read-modify-write on `sessions.state` running in the cron drain,
   * entirely outside the session's Durable Object — so between the read above
   * and this write, a click can have crossed quorum and `settle()` can have
   * written CONFIRMED. An unguarded UPDATE would overwrite it, and the post
   * would go on saying "Confirmed" over a row that says JEOPARDY.
   *
   * The clock loses that race on purpose: a person clicking In is newer
   * information than a tally read a moment ago.
   */
  await db(env)
    .update(schema.sessions)
    .set({ state: "JEOPARDY", updatedAt: sql`(unixepoch())` })
    .where(
      and(
        eq(schema.sessions.id, session.id),
        inArray(schema.sessions.state, ["SCHEDULED", "JEOPARDY"]),
      ),
    );

  return "in-jeopardy";
}
