import { eq, sql } from "drizzle-orm";
import type { Env } from "../env.ts";
import { db, schema } from "../db/index.ts";
import {
  SETTING_DEFAULTS,
  SETTING_KEYS,
  settingOr,
} from "../db/settings.ts";
import { armAssume } from "../attendance/assume.ts";
import { enqueueUnprojection } from "../projection/outbox.ts";
import { POST_SIGNUP_JOB } from "./post.ts";
import { gameDayTitle } from "../projection/target.ts";
import type { MessagePayload } from "../attendance/render.ts";

/**
 * `PROPOSED → SEATING → LOCKED → PLAYED`, with `CANCELLED` reachable from
 * anywhere before the end, and nothing else.
 *
 * One function, one edge map, and an `audit_log` row written in the same batch
 * as the state change — so there is no way to move a day without leaving the
 * record of who moved it. The console calls this; so will the lock job and the
 * assume job. It is the only place `game_days.state` is written.
 *
 * Two absences in the map are the enforcement rather than oversights:
 *
 * - **`PLAYED` has no outgoing edges.** It is terminal. A day that is somehow
 *   run again is a new day with its own date, which is the honest thing for a
 *   row keyed on one to describe.
 * - **Nothing goes backwards.** `LOCKED → SEATING` in particular: locking is how
 *   the table stops moving, and a table that can be un-stopped by a click never
 *   really stopped. Re-opening is a decision about a *new* day.
 */
export type GameDayState = (typeof schema.gameDays.$inferSelect)["state"];

const EDGES: Record<GameDayState, readonly GameDayState[]> = {
  PROPOSED: ["SEATING", "CANCELLED"],
  SEATING: ["LOCKED", "CANCELLED"],
  LOCKED: ["PLAYED", "CANCELLED"],
  PLAYED: [],
  CANCELLED: [],
};

export class IllegalDayTransition extends Error {
  readonly from: GameDayState;
  readonly to: GameDayState;

  constructor(gameDayId: string, from: GameDayState, to: GameDayState) {
    super(`game day ${gameDayId} cannot go ${from} → ${to}`);
    this.name = "IllegalDayTransition";
    this.from = from;
    this.to = to;
  }
}

export interface DayTransitionResult {
  from: GameDayState;
  to: GameDayState;
  /** False when the day was already there: nothing written, nothing logged. */
  changed: boolean;
  /** The session this day's evening hangs off, once it has one. */
  sessionId?: string;
}

/**
 * The session a day gets when seating opens.
 *
 * Derived from the day's id rather than minted, and that is what makes opening
 * seating replayable: a half-finished transition can simply be run again, and
 * the second run inserts nothing rather than producing a second evening.
 */
export function sessionIdFor(gameDayId: string): string {
  return `gd-${gameDayId}`;
}

/**
 * `actor` is the Discord id of whoever asked, or null for the clock. Null is not
 * a shrug — it is the honest answer when the lock job or the assume job acts,
 * because they act on nobody's behalf.
 */
export async function transition(
  env: Env,
  gameDayId: string,
  to: GameDayState,
  actor: string | null = null,
): Promise<DayTransitionResult> {
  const d = db(env);
  const day = await d
    .select()
    .from(schema.gameDays)
    .where(eq(schema.gameDays.id, gameDayId))
    .get();

  if (!day) throw new Error(`no game day ${gameDayId}`);
  const from = day.state;

  // Already there. A double-click is not an error, and it is not history
  // either: an audit row saying SEATING → SEATING is noise in the one log that
  // has to stay readable.
  if (from === to) return { from, to, changed: false };

  if (!EDGES[from].includes(to)) throw new IllegalDayTransition(gameDayId, from, to);

  const moved = d
    .update(schema.gameDays)
    .set({ state: to, updatedAt: sql`(unixepoch())` })
    .where(eq(schema.gameDays.id, gameDayId));

  const logged = d.insert(schema.auditLog).values({
    id: crypto.randomUUID(),
    actorUserId: actor,
    action: "gameday.transition",
    targetType: "game_day",
    targetId: gameDayId,
    detail: { before: from, after: to },
  });

  // Opening seating is where a day becomes a thing with a calendar presence.
  // Everything after this point — the Discord event, the Google event, the
  // attendance post, the reminders, the register — is machinery phases 1–3
  // already built, and all of it hangs off a session row.
  if (to !== "SEATING") {
    const existing = await d
      .select({ id: schema.sessions.id, state: schema.sessions.state })
      .from(schema.sessions)
      .where(eq(schema.sessions.id, sessionIdFor(gameDayId)))
      .get();

    if (to !== "CANCELLED" || !existing) {
      await d.batch([moved, logged]);
      return { from, to, changed: true, ...(existing ? { sessionId: existing.id } : {}) };
    }

    await d.batch([
      moved,
      logged,
      // The evening is off, so the session is off. Leaving it SCHEDULED would
      // let a late `attendance.assume` write a register for a day nobody played,
      // and `assumeAttendance` reads exactly this column to decide.
      d
        .update(schema.sessions)
        .set({ state: "CANCELLED", updatedAt: sql`(unixepoch())` })
        .where(eq(schema.sessions.id, existing.id)),
      // One notice, in the day's thread. A job rather than a post made here, so
      // the console's click answers at once — and claimed under its own label,
      // which is what makes cancelling twice post once.
      d
        .insert(schema.jobs)
        .values({
          id: `${CANCELLED_JOB}:${gameDayId}`,
          kind: CANCELLED_JOB,
          payload: { gameDayId },
          idempotencyKey: `${CANCELLED_JOB}:${gameDayId}`,
          runAt: sql`(unixepoch())`,
        })
        .onConflictDoNothing(),
    ]);

    // Both surfaces, and not gated on the day still being projectable: a delete
    // is how something published comes down, and `project`'s retract branch is
    // deliberately ungated for exactly this. Gating it would strand a cancelled
    // day's event on everybody's calendar for good.
    await enqueueUnprojection(env, existing.id);

    return { from, to, changed: true, sessionId: existing.id };
  }

  const sessionId = sessionIdFor(gameDayId);
  const minted = d
    .insert(schema.sessions)
    .values({
      id: sessionId,
      kind: "one_off",
      gameDayId,
      startsAt: day.startsAt,
      endsAt: day.endsAt,
    })
    // The id is derived from the day, so a replay finds this row and stops.
    // Nothing here defends "exactly one parent" by hand: `game_day_id` is set
    // and `campaign_id` is not, which is what `hasExactlyOneParent` asks.
    .onConflictDoNothing();

  await d.batch([
    moved,
    minted,
    logged,
    // Three standing jobs. Each key is derived from the session, so a re-run of
    // a half-finished transition writes none of them a second time.
    d
      .insert(schema.jobs)
      .values([
        {
          id: `session.project:${sessionId}`,
          kind: "session.project",
          payload: { sessionId },
          idempotencyKey: `session.project:${sessionId}`,
          runAt: sql`(unixepoch())`,
        },
        {
          // The signup post, now — a day in SEATING with no post is a day
          // nobody can claim a place at, so there is no lead time to wait out.
          id: `${POST_SIGNUP_JOB}:${gameDayId}`,
          kind: POST_SIGNUP_JOB,
          payload: { gameDayId },
          idempotencyKey: `${POST_SIGNUP_JOB}:${gameDayId}`,
          runAt: sql`(unixepoch())`,
        },
      ])
      .onConflictDoNothing(),
  ]);

  // And the register, when it is over. Armed outside the batch because it
  // upserts its `run_at` rather than being written once — the day can move.
  await armAssume(env, sessionId, day.endsAt);

  // And the moment the table settles. Also an upsert rather than a one-time
  // write, for the same reason: a day whose date moves has to take its lock
  // with it, or it fires a lead time before the wrong evening.
  await armLock(env, gameDayId, day.startsAt);

  return { from, to, changed: true, sessionId };
}

/**
 * The lead-time lock, armed and handled in the same PR.
 *
 * The job is a *fallback*, not the mechanism: an organiser locking by hand is
 * the normal path and this is what happens when nobody does. So the handler is
 * written to be harmless on a day that is already locked, already played or
 * already called off — it asks `transition`, which refuses those moves, rather
 * than writing the state itself.
 */
export const LOCK_JOB = "game-day.lock";

/** The one message a called-off day sends. */
export const CANCELLED_JOB = "game-day.cancelled";

export async function armLock(env: Env, gameDayId: string, startsAt: number): Promise<void> {
  const hours = await settingOr<number>(
    env,
    SETTING_KEYS.gameDayLockLeadHours,
    SETTING_DEFAULTS[SETTING_KEYS.gameDayLockLeadHours],
  );
  const id = `${LOCK_JOB}:${gameDayId}`;

  await db(env)
    .insert(schema.jobs)
    .values({
      id,
      kind: LOCK_JOB,
      payload: { gameDayId },
      idempotencyKey: id,
      runAt: startsAt - hours * 3600,
    })
    .onConflictDoUpdate({
      target: schema.jobs.id,
      set: { runAt: startsAt - hours * 3600, state: "pending", attempts: 0, lastError: null },
    });
}

/**
 * What the clock does when the lead time comes.
 *
 * A day the organiser already locked, played or called off is left exactly as it
 * is — `transition` says no to all three, and the answer here is to stop rather
 * than to throw, because a job that fails on the ordinary case is a job that
 * fills `last_error` with nothing wrong.
 */
export async function lockIfSeating(env: Env, gameDayId: string): Promise<boolean> {
  const day = await db(env)
    .select({ state: schema.gameDays.state })
    .from(schema.gameDays)
    .where(eq(schema.gameDays.id, gameDayId))
    .get();

  // Gone. Nothing to lock and nothing to retry.
  if (!day || day.state !== "SEATING") return false;

  // Null actor: the clock acts on nobody's behalf, and the audit log should say
  // so rather than name whoever happened to open seating.
  const result = await transition(env, gameDayId, "LOCKED", null);
  return result.changed;
}

/**
 * How a day that was played ends.
 *
 * It rides phase 3's `attendance.assume` job at `ends_at` — no new job and no
 * new clock. The evening is over, so there is nothing left to decide.
 *
 * A day still `SEATING` at the end of its own evening never got locked: the lock
 * job failed, or the lead time was longer than the notice. It is locked on the
 * way past rather than being left in a state the map gives it no way out of —
 * the table has certainly settled by the time the day is over.
 *
 * A day that was called off is not played, and is left exactly as it is.
 */
export async function playAfterAssume(env: Env, gameDayId: string): Promise<boolean> {
  const state = async () =>
    (
      await db(env)
        .select({ state: schema.gameDays.state })
        .from(schema.gameDays)
        .where(eq(schema.gameDays.id, gameDayId))
        .get()
    )?.state;

  if ((await state()) === "SEATING") await transition(env, gameDayId, "LOCKED", null);
  if ((await state()) !== "LOCKED") return false;

  return (await transition(env, gameDayId, "PLAYED", null)).changed;
}

/**
 * "It's off." One new message in the day's thread, and the only thing a
 * cancellation says.
 *
 * The signup post is not touched. Its buttons still work in the sense that
 * Discord will deliver the clicks, and the `seat` handler answers each one
 * ephemerally with what happened — which is the same answer a locked day gives,
 * for the same reason.
 */
export function cancelledNotice(
  day: typeof schema.gameDays.$inferSelect,
  game: typeof schema.games.$inferSelect | null,
): MessagePayload {
  return {
    content: [
      `**It's off.** ${gameDayTitle(day, game)} is not happening.`,
      `It was <t:${day.startsAt}:F>${day.venue ? `, ${day.venue}` : ""}.`,
      "",
      "-# The calendar entries have been taken down.",
    ].join("\n"),
    components: [],
    // Nobody in particular. A day is open to the room, and a cancellation is
    // news rather than a summons.
    allowed_mentions: { parse: [], roles: [] },
  };
}

/** Whether this day is still taking seats. Only SEATING is. */
export function isSeating(day: { state: GameDayState }): boolean {
  return day.state === "SEATING";
}
