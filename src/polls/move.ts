import { eq, sql } from "drizzle-orm";
import type { Env } from "../env.ts";
import { db, schema } from "../db/index.ts";
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
  when: { startsAt: number; endsAt: number },
  wasStartsAt?: number,
): Promise<boolean> {
  const before = await loadProjectionTarget(env, sessionId);
  if (!before) return false;

  const { session } = before;
  const from = wasStartsAt ?? session.startsAt;
  if (from === when.startsAt && session.endsAt === when.endsAt) return false;

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
      ...(lapsed ? { discordEventId: null, discordEventFingerprint: null } : {}),
      updatedAt: sql`(unixepoch())`,
    })
    .where(eq(schema.sessions.id, sessionId));

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
