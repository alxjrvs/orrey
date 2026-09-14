import { eq, sql } from "drizzle-orm";
import type { Env } from "../env.ts";
import { db, schema } from "../db/index.ts";
import { armAssume } from "../attendance/assume.ts";
import { armJeopardyCheck } from "../attendance/jeopardy.ts";
import { armReminders } from "../attendance/reminders.ts";
import { postToSession } from "../attendance/thread.ts";
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
 * Three things happen and they are deliberately in this order: D1 first, because
 * it is the source of truth and everything else is a projection of it; then the
 * notice, because people should hear from the thread rather than from a calendar
 * entry moving under them; then the jobs that re-project.
 */
export async function moveSession(
  env: Env,
  sessionId: string,
  when: { startsAt: number; endsAt: number },
): Promise<boolean> {
  const before = await loadProjectionTarget(env, sessionId);
  if (!before) return false;

  const { session } = before;
  if (session.startsAt === when.startsAt && session.endsAt === when.endsAt) return false;

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
  const lapsed = session.startsAt <= Math.floor(Date.now() / 1000);

  await db(env)
    .update(schema.sessions)
    .set({
      startsAt: when.startsAt,
      endsAt: when.endsAt,
      ...(lapsed ? { discordEventId: null, discordEventFingerprint: null } : {}),
      updatedAt: sql`(unixepoch())`,
    })
    .where(eq(schema.sessions.id, sessionId));

  const after = await loadProjectionTarget(env, sessionId);
  if (!after) return false;

  // A new message in the thread. Nothing in this path edits the attendance post
  // or the poll post — the attendance post renders from D1, so the next click on
  // it shows the new date on its own.
  await postToSession(env, after, movedNotice(after, session.startsAt));

  // Both surfaces re-project, and every time-based job the session has is
  // re-armed: the jeopardy check, the reminders and the register were all
  // pointing at the old day. Each of those arms is an upsert that *moves* its
  // row rather than adding one, which is the property that makes a move safe to
  // repeat.
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
