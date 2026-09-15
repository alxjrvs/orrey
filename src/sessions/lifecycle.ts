import { eq, sql } from "drizzle-orm";
import type { Env } from "../env.ts";
import { db, schema } from "../db/index.ts";
import { enqueueUnprojection } from "../projection/outbox.ts";
import { loadProjectionTarget } from "../projection/target.ts";
import { postNoticeOnce } from "../attendance/notice.ts";
import { cancelledSessionNotice } from "../attendance/render.ts";

/**
 * Locking a session, and calling one off.
 *
 * Domain functions, not console handlers. The console is a caller — that is what
 * keeps "every write lands in `audit_log`" true rather than hopeful, and it is
 * why the cancel that the bot would do and the cancel a button does are the same
 * cancel rather than two that drift.
 *
 * The third action #43 asks for, opening a targeted poll, is already a domain
 * function: `openPoll`. There is deliberately nothing here for it.
 */
export type SessionAction = "locked" | "cancelled" | "already" | "no-session" | "too-late";

/**
 * The table has stopped moving.
 *
 * Intent changes are refused from here on, the jeopardy check stops treating it
 * as waiting, and a click cannot confirm it. **Nothing unlocks**, for the reason
 * a locked game day does not: a table that can be un-stopped by a click never
 * really stopped, and re-opening one is a decision about a different evening.
 *
 * A session that is already over, or already off, is too late to lock — and
 * saying so is better than a no-op that reads as success.
 */
export async function lockSession(
  env: Env,
  sessionId: string,
  actor: string | null = null,
): Promise<SessionAction> {
  const d = db(env);
  const session = await d
    .select({ state: schema.sessions.state })
    .from(schema.sessions)
    .where(eq(schema.sessions.id, sessionId))
    .get();

  if (!session) return "no-session";
  if (session.state === "LOCKED") return "already";
  if (session.state === "PLAYED" || session.state === "CANCELLED") return "too-late";

  await d.batch([
    d
      .update(schema.sessions)
      .set({ state: "LOCKED", updatedAt: sql`(unixepoch())` })
      .where(eq(schema.sessions.id, sessionId)),
    audit(d, actor, "session.lock", sessionId, { before: session.state, after: "LOCKED" }),
  ]);

  return "locked";
}

/**
 * It is off.
 *
 * Three things, and the order is the usual one: D1 first because it is the
 * source of truth; then the deletes, which are queue messages rather than calls;
 * then the notice, as a **new message in the thread**.
 *
 * The deletes are not gated on the session still being projectable. `project`'s
 * retract branch is deliberately ungated for exactly this, and gating them would
 * strand a cancelled session's event on everybody's calendar for good.
 *
 * No `ics_sequence` here. That column arrives on the other root of this phase,
 * and the bump belongs inside this function rather than in a console handler —
 * which is what lets this slice be green on its own and means the console gets
 * the bump for free the moment both roots are in `main`. A handler that
 * incremented a sequence itself would be the second place that does.
 */
export async function cancelSession(
  env: Env,
  sessionId: string,
  actor: string | null = null,
): Promise<SessionAction> {
  const target = await loadProjectionTarget(env, sessionId);
  if (!target) return "no-session";
  if (target.session.state === "CANCELLED") return "already";
  if (target.session.state === "PLAYED") return "too-late";

  const before = target.session.state;
  const d = db(env);

  await d.batch([
    d
      .update(schema.sessions)
      .set({ state: "CANCELLED", updatedAt: sql`(unixepoch())` })
      .where(eq(schema.sessions.id, sessionId)),
    audit(d, actor, "session.cancel", sessionId, { before, after: "CANCELLED" }),
  ]);

  await enqueueUnprojection(env, sessionId);

  // Re-read: the notice says the session is off, and it should be rendering the
  // row that says so rather than the one from before the write.
  const off = (await loadProjectionTarget(env, sessionId)) ?? target;
  // A new message, claimed under its own label so a second cancel posts nothing.
  // Nothing in this path edits the attendance post — it renders from D1, so the
  // next click on it shows the new state on its own.
  await postNoticeOnce(env, off, "cancelled", cancelledSessionNotice(off));

  return "cancelled";
}

/** Whether a click may still change what somebody said. */
export function takesIntent(session: { state: string }): boolean {
  return session.state !== "LOCKED" && session.state !== "CANCELLED" && session.state !== "PLAYED";
}

function audit(
  d: ReturnType<typeof db>,
  actorUserId: string | null,
  action: string,
  targetId: string,
  detail: Record<string, unknown>,
) {
  return d.insert(schema.auditLog).values({
    id: crypto.randomUUID(),
    actorUserId,
    action,
    targetType: "session",
    targetId,
    detail,
  });
}
