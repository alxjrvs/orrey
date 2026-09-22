import { eq } from "drizzle-orm";
import type { Env } from "../env.ts";
import { db, schema } from "../db/index.ts";
import { rearm, type ArmedJob } from "../jobs/arm.ts";
import { SETTING_DEFAULTS, SETTING_KEYS, settingOr } from "../db/settings.ts";
import { attendanceRows } from "./rows.ts";
import { quorumOf } from "./quorum.ts";
import { tryDm } from "./dm.ts";
import { postNoticeOnce } from "./notice.ts";
import { claim, record } from "../projection/publications.ts";
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

/**
 * The ladder's rows, described — one per step. The steps are a settings read,
 * so a caller batching these with a state write gets the read out of the way
 * first, which is the point.
 */
export async function reminderJobs(
  env: Env,
  sessionId: string,
  startsAt: number,
): Promise<ArmedJob[]> {
  const steps = await settingOr<number[]>(
    env,
    SETTING_KEYS.reminderStepsHours,
    SETTING_DEFAULTS["reminder.steps_hours"] as unknown as number[],
  );

  return steps.map((hours) => ({
    id: `${REMINDER_JOB}:${sessionId}:${hours}`,
    kind: REMINDER_JOB,
    payload: { sessionId, hours },
    runAt: startsAt - hours * 3600,
  }));
}

export async function armReminders(
  env: Env,
  sessionId: string,
  startsAt: number,
): Promise<void> {
  // A moved session moves its whole ladder, for the same reason the jeopardy
  // check moves: a nudge at the old T-24h is a nudge on the wrong day.
  await rearm(db(env), await reminderJobs(env, sessionId, startsAt));
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

  /**
   * The ladder still nudges the silent under the veto rule, and it is worth saying
   * why, because "silence is in" sounds like a reason to stop.
   *
   * It is the reason to keep going. The rule holds an evening together on the
   * assumption that anybody who cannot make it will say so, and a DM the day
   * before is the last easy moment to say it. What changes is the *wording* — the
   * nudge asks them to do nothing unless something is wrong, rather than telling
   * a table that took the post at its word that it has not answered.
   */
  const { rule } = quorumOf(target, rows);

  const dmed: string[] = [];
  const mentioned: string[] = [];

  /**
   * One claim per person per rung, and that is not belt and braces.
   *
   * The only thing in this function that can throw is the thread post at the
   * bottom, and the drain answers a throw by re-running the whole thing from the
   * top. Without a record of who has already been asked, every retry re-DMs
   * everybody — and on a 4xx the thread claim is *released*, so the next run
   * fails the same way, releases again, and keeps going until the session is
   * marked played. `users.dm_state` does not help: it remembers a *closed* DM,
   * never a delivered one.
   *
   * So each person's rung gets a row of its own. The id it records is the
   * outcome, because for a DM there is nothing else worth remembering.
   */
  for (const row of silent) {
    const ref = {
      surface: "discord",
      kind: "message",
      targetId: session.id,
      label: `${label(hours)}:${row.userId}`,
    } as const;

    const { mine, publication } = await claim(env, ref);
    if (!mine) {
      // Settled on an earlier run of this rung.
      if (publication.remoteId === CLOSED) mentioned.push(row.userId);
      else if (publication.remoteId) dmed.push(row.userId);
      // A claim with no outcome is a run that died mid-DM. Whether it landed is
      // unknowable, and a duplicate DM is the thing this whole structure exists
      // to prevent — so this person is neither asked again nor named in the
      // thread. Silence beats saying it twice.
      continue;
    }

    // One person's shut DMs must not stop the rest being asked.
    const outcome = await tryDm(env, row.userId, remindDm(target, hours, rule)).catch((error) => {
      console.error("reminder DM failed", session.id, row.userId, error);
      return "closed" as const;
    });

    await record(env, ref, outcome === "sent" ? SENT : CLOSED);

    if (outcome === "sent") dmed.push(row.userId);
    else mentioned.push(row.userId);
  }

  // One message for everybody unreachable, not one each: the thread is shared,
  // and three separate mentions of three people is three notifications for all
  // of them.
  if (mentioned.length > 0) {
    await postNoticeOnce(env, target, label(hours), remindInThread(target, hours, mentioned, rule));
  }

  return { dmed, mentioned };
}

/** This rung's label in the ledger. The person's id is appended for their DM. */
function label(hours: number): string {
  return `reminder-${hours}`;
}

/**
 * What a settled DM records. A DM has no id worth keeping — Orrey will never go
 * back to one — so the row remembers the *outcome*, which is the thing a retry
 * needs to know.
 */
const SENT = "sent";
const CLOSED = "closed";
