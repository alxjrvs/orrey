import { and, eq, sql } from "drizzle-orm";
import type { Env } from "../env.ts";
import { db, schema } from "../db/index.ts";
import { SESSION_MOVED } from "../db/audit.ts";
import { bumpIcsSequence } from "../ics/sequence.ts";
import { armAssume } from "../attendance/assume.ts";
import { armJeopardyCheck } from "../attendance/jeopardy.ts";
import { armReminders } from "../attendance/reminders.ts";
import { postNoticeOnce } from "../attendance/notice.ts";
import {
  loadProjectionTarget,
  sessionTitle,
  type ProjectionTarget,
} from "../projection/target.ts";
import { escapeMarkdown } from "../discord/markdown.ts";
import type { MessagePayload } from "../attendance/render.ts";

/**
 * Moving a session to the date that won.
 *
 * D1 first, because it is the source of truth and everything else is a
 * projection of it. Then the re-arming, then the notice — and that order is the
 * one thing here worth arguing about, because it is the reverse of what reads
 * naturally.
 *
 * It is this way round because **this function is retried**. It runs from the
 * `poll.apply` job, and every step after the D1 write has to survive being run
 * again: the arms are upserts that move a row rather than adding one, and the
 * notice is claimed under a label so it goes out exactly once however many times
 * this is re-entered. Posting before arming meant a refused Discord call left
 * the session moved with the jeopardy check, the reminders and the register all
 * still pointing at the old day.
 *
 * `wasStartsAt` is the date the poll was applied *from*, carried in the job's
 * payload rather than read back off the session. On a retry the session is
 * already at the new date, so reading it would produce a notice saying a session
 * moved from where it is to where it is.
 */
export async function moveSession(
  env: Env,
  sessionId: string,
  when: { startsAt: number; endsAt: number; location?: string | null },
  wasStartsAt?: number,
): Promise<boolean> {
  const before = await loadProjectionTarget(env, sessionId);
  if (!before) return false;

  const { session } = before;
  const from = wasStartsAt ?? session.startsAt;
  // `location` is only carried by the caller that has one to carry — the
  // inbound path, where somebody retyped the venue in the same drag. Undefined
  // means "leave it as it is", which is what every other caller means.
  const venueMoved = when.location !== undefined && when.location !== session.location;
  if (from === when.startsAt && session.endsAt === when.endsAt && !venueMoved) return false;

  /**
   * Discord's scheduled event is the half that cannot be updated in place.
   * `COMPLETED` and `CANCELED` are terminal and fire on their own, so an event
   * whose old start time has already passed cannot be PATCHed to a new one.
   *
   * So when the old date is behind us the stored id is dropped and `upsert`
   * takes its create branch. **The fingerprint goes with it** — leaving it
   * behind would make the next upsert compare the new content against a stale
   * hash, decide nothing changed, and skip the write it most needs to make.
   */
  const lapsed = from <= Math.floor(Date.now() / 1000);

  await db(env)
    .update(schema.sessions)
    .set({
      startsAt: when.startsAt,
      endsAt: when.endsAt,
      ...(when.location === undefined ? {} : { location: when.location }),
      ...(lapsed ? { discordEventId: null, discordEventFingerprint: null } : {}),
      // The date moved, so every subscribed calendar has to be told this update
      // supersedes the one it holds. The `+ 1` itself lives in one place.
      ...bumpIcsSequence,
      updatedAt: sql`(unixepoch())`,
    })
    .where(eq(schema.sessions.id, sessionId));

  /**
   * The objections went with the date.
   *
   * `carryOver` already clears every intent when a *poll* resolves, for the reason
   * it states: a stale "out" about a Tuesday is not an answer about a Thursday. A
   * move made any other way — the console, a `p7/12` edit somebody made in Google
   * — did not, and since `p8/3` that is not a cosmetic difference: an `out` is the
   * one intent that now *does* something, so one left behind vetoed the new date
   * the moment it existed, and the date after that, for ever.
   *
   * Only the `out` rows, and deliberately so. An `in` or a `maybe` is surface-only
   * and carrying it over is the behaviour every caller already had; an `out` is
   * load-bearing now, and it is the one that cannot outlive the evening it was
   * about.
   */
  await db(env)
    .update(schema.attendance)
    .set({ intent: null, updatedAt: sql`(unixepoch())` })
    .where(and(eq(schema.attendance.sessionId, sessionId), eq(schema.attendance.intent, "out")));

  // The move, on the record. Written here rather than at each caller because a
  // session moves from three places — a poll that resolved, a reschedule, and
  // from `p7/12` an edit somebody made in Google — and a trail with a hole in it
  // for one of them is a statistic that undercounts without ever looking wrong.
  await db(env)
    .insert(schema.auditLog)
    .values({
      id: crypto.randomUUID(),
      // Null is the clock. A move Orrey made on nobody's behalf says so.
      actorUserId: null,
      action: SESSION_MOVED,
      targetType: "session",
      targetId: sessionId,
      detail: { before: { startsAt: from, endsAt: session.endsAt }, after: when },
    });

  const after = await loadProjectionTarget(env, sessionId);
  if (!after) return false;

  // Both surfaces re-project, and every time-based job the session has is
  // re-armed: the jeopardy check, the reminders and the register were all
  // pointing at the old day. Each of those arms is an upsert that *moves* its
  // row rather than adding one, which is the property that makes a move safe to
  // repeat — and is why they go before the one step that talks to Discord.
  await db(env)
    .insert(schema.jobs)
    .values({
      id: `session.project:${sessionId}`,
      kind: "session.project",
      payload: { sessionId },
      idempotencyKey: `session.project:${sessionId}`,
      runAt: sql`(unixepoch())`,
    })
    .onConflictDoUpdate({
      target: schema.jobs.id,
      set: { runAt: sql`(unixepoch())`, state: "pending", attempts: 0, lastError: null },
    });

  await armJeopardyCheck(env, sessionId, when.startsAt);
  await armReminders(env, sessionId, when.startsAt);
  await armAssume(env, sessionId, when.endsAt);

  // A new message in the thread, claimed under a label so a retry does not post
  // a second one. Nothing in this path edits the attendance post or the poll
  // post — the attendance post renders from D1, so the next click on it shows
  // the new date on its own.
  await postNoticeOnce(env, after, `moved:${when.startsAt}`, movedNotice(after, from));

  return true;
}

/**
 * What the thread is told. It names the old date as well as the new one, because
 * "it moved" is only useful to somebody who knows what it moved from.
 */
export function movedNotice(target: ProjectionTarget, wasStartsAt: number): MessagePayload {
  const { session, campaign } = target;
  return {
    content: [
      `**Moved.** ${escapeMarkdown(sessionTitle(target))}`,
      `~~<t:${wasStartsAt}:F>~~ → <t:${session.startsAt}:F>`,
      "",
      "The post above is still the place to answer; it shows the new date.",
    ].join("\n"),
    components: [],
    allowed_mentions: {
      parse: [],
      roles: campaign?.discordRoleId ? [campaign.discordRoleId] : [],
    },
  };
}
