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

/** The states a session can still be found short — or objected to — in. */
const WATCHED = new Set(["SCHEDULED", "JEOPARDY", "CONFIRMED"]);

/**
 * The label the day-out notice is claimed under — **the date, not the session**.
 *
 * `postNoticeOnce` makes a notice once per label, and a session-scoped label made
 * it once per *session*: a vetoed evening moved by a date poll, then vetoed again
 * on its new date, found the old claim standing and posted nothing. The table
 * would have been told the first time and never again, however many dates the
 * campaign worked through. `moveSession` already date-scopes its own notice for
 * exactly this reason.
 */
export function jeopardyLabel(startsAt: number): string {
  return `jeopardy:${startsAt}`;
}

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

  /**
   * Cancelled, played, locked: none of these is a session waiting to find out
   * whether it runs.
   *
   * **JEOPARDY is not one of them.** A session already marked short is one this
   * check has run on before — and the run that marked it may well have failed to
   * post the notice afterwards. Answering "not-waiting" here made the state write
   * the thing that enforced "once", so a single refused Discord call lost the
   * notice for ever: the retry could never reach the post again. The claim in
   * `postNoticeOnce` is what makes it once; this only has to be honest about what
   * it found.
   *
   * **And nor, any longer, is CONFIRMED.** Under a count it is settled and stays
   * settled — #28 is explicit that dropping below does not un-confirm, and the
   * clock is not the thing that overrules that — so the early answer for it moved
   * below the verdict rather than disappearing. Under the veto rule it is not
   * settled at all: `vetoed()` lists CONFIRMED among the states an objection acts
   * on, and answering "confirmed" here without looking meant an `out` that
   * arrived from the console after a confirmation was invisible to the clock,
   * over a post already reading "Can't run as it stands". Catching exactly that
   * is why the clock runs this rule at all.
   */
  if (!WATCHED.has(session.state)) return "not-waiting";

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
  // #28's rule, now that CONFIRMED reaches the verdict: under a count, confirmed
  // is confirmed however few are in.
  if (quorum.rule === "quorum" && session.state === "CONFIRMED") return "confirmed";
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
        /**
         * The guard depends on the rule, and it has to.
         *
         * Under a count, CONFIRMED is what the clock must never overwrite — a
         * click crossing quorum between the read above and this write is newer
         * information than a tally read a moment ago, and the early answer for
         * CONFIRMED cannot cover it because that answer reads the *stale* state
         * this call was handed. The guard is the only thing that sees the row as
         * it is now. `test/jeopardy.test.ts` pins it.
         *
         * Under the veto rule there is no such race to lose: nothing writes
         * CONFIRMED at all (`crossesThreshold` declines), so any CONFIRMED row is
         * an older one or an organiser's, and marking it is exactly the point.
         */
        inArray(
          schema.sessions.state,
          quorum.rule === "unanimous"
            ? ["SCHEDULED", "JEOPARDY", "CONFIRMED"]
            : ["SCHEDULED", "JEOPARDY"],
        ),
      ),
    );

  return "in-jeopardy";
}
