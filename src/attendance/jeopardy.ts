import { eq, sql } from "drizzle-orm";
import type { Env } from "../env.ts";
import { db, schema } from "../db/index.ts";
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
export async function armJeopardyCheck(
  env: Env,
  sessionId: string,
  startsAt: number,
): Promise<void> {
  const leadHours = await settingOr(
    env,
    SETTING_KEYS.jeopardyLeadHours,
    SETTING_DEFAULTS["jeopardy.lead_hours"],
  );
  const runAt = startsAt - leadHours * 3600;
  const id = `${JEOPARDY_JOB}:${sessionId}`;

  await db(env)
    .insert(schema.jobs)
    .values({
      id,
      kind: JEOPARDY_JOB,
      payload: { sessionId },
      idempotencyKey: id,
      runAt,
    })
    .onConflictDoUpdate({
      target: schema.jobs.id,
      // A moved session is a moved check: pending again, at the new time, with
      // the old failure forgotten.
      set: { runAt, state: "pending", attempts: 0, lastError: null },
    });
}

export type JeopardyOutcome = "confirmed" | "in-jeopardy" | "no-quorum-set" | "not-waiting";

/**
 * What the check found. It writes `sessions.state` and nothing else — no notice,
 * no cancellation. #29 is explicit that when the answer is no the response is a
 * date poll rather than a cancellation, so this marks the session and leaves the
 * deciding to people.
 */
export async function checkJeopardy(
  env: Env,
  target: ProjectionTarget,
): Promise<JeopardyOutcome> {
  const { session } = target;

  // Already confirmed, already cancelled, already played. None of these is a
  // session waiting to find out whether it runs.
  if (session.state !== "SCHEDULED") {
    return session.state === "CONFIRMED" ? "confirmed" : "not-waiting";
  }

  const quorum = quorumOf(target, await attendanceRows(env, session.id));

  // A campaign that never said what quorum is has not asked this question, and
  // Orrey does not get to answer it on their behalf.
  if (quorum.required === null) return "no-quorum-set";
  if (quorum.met) return "confirmed";

  await db(env)
    .update(schema.sessions)
    .set({ state: "JEOPARDY", updatedAt: sql`(unixepoch())` })
    .where(eq(schema.sessions.id, session.id));

  return "in-jeopardy";
}
