import { eq } from "drizzle-orm";
import type { Env } from "../env.ts";
import { db, schema } from "../db/index.ts";
import { SETTING_DEFAULTS, SETTING_KEYS, settingOr } from "../db/settings.ts";
import { attendanceRows } from "./rows.ts";
import { tryDm } from "./dm.ts";
import { postNoticeOnce } from "./notice.ts";
import { remindDm, remindInThread } from "./render.ts";
import type { ProjectionTarget } from "../projection/target.ts";

/**
 * The ladder. Three nudges before a session, at hours taken from `settings`.
 *
 * Two rules do most of the work:
 *
 * - **Only the people who have not answered.** `in` and `out` are answers; null
 *   and `maybe` are not, and a reminder sent to somebody who already said yes is
 *   the thing that teaches a server to mute a bot.
 * - **Each step is a new message.** Nothing edits anything, here or anywhere —
 *   which is why three nudges are three messages rather than one that changes.
 */
export const REMINDER_JOB = "reminder.step";

export async function armReminders(
  env: Env,
  sessionId: string,
  startsAt: number,
): Promise<void> {
  const steps = await settingOr<number[]>(
    env,
    SETTING_KEYS.reminderStepsHours,
    SETTING_DEFAULTS["reminder.steps_hours"] as unknown as number[],
  );

  for (const hours of steps) {
    const id = `${REMINDER_JOB}:${sessionId}:${hours}`;
    const runAt = startsAt - hours * 3600;

    await db(env)
      .insert(schema.jobs)
      .values({
        id,
        kind: REMINDER_JOB,
        payload: { sessionId, hours },
        idempotencyKey: id,
        runAt,
      })
      // A moved session moves its whole ladder, for the same reason the jeopardy
      // check moves: a nudge at the old T-24h is a nudge on the wrong day.
      .onConflictDoUpdate({
        target: schema.jobs.id,
        set: { runAt, state: "pending", attempts: 0, lastError: null },
      });
  }
}

export interface ReminderOutcome {
  /** People who got a DM. */
  dmed: string[];
  /** People whose DMs are shut, and who were mentioned in the thread instead. */
  mentioned: string[];
}

export async function sendReminder(
  env: Env,
  target: ProjectionTarget,
  hours: number,
): Promise<ReminderOutcome> {
  const { session } = target;
  const nothing = { dmed: [], mentioned: [] };

  // A session that is off, or already played, has nothing to remind anybody of.
  if (session.state === "CANCELLED" || session.state === "PLAYED") return nothing;

  const rows = await attendanceRows(env, session.id);
  const silent = rows.filter((row) => row.intent === null || row.intent === "maybe");
  if (silent.length === 0) return nothing;

  const dmed: string[] = [];
  const mentioned: string[] = [];

  for (const row of silent) {
    // One person's shut DMs must not stop the rest being asked.
    const outcome = await tryDm(env, row.userId, remindDm(target, hours)).catch((error) => {
      console.error("reminder DM failed", session.id, row.userId, error);
      return "closed" as const;
    });

    if (outcome === "sent") dmed.push(row.userId);
    else mentioned.push(row.userId);
  }

  // One message for everybody unreachable, not one each: the thread is shared,
  // and three separate mentions of three people is three notifications for all
  // of them.
  if (mentioned.length > 0) {
    await postNoticeOnce(
      env,
      target,
      `reminder-${hours}`,
      remindInThread(target, hours, mentioned),
    );
  }

  return { dmed, mentioned };
}
