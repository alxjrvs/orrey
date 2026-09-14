import { eq, sql } from "drizzle-orm";
import type { Env } from "../env.ts";
import { db, schema } from "../db/index.ts";
import {
  SETTING_DEFAULTS,
  SETTING_KEYS,
  settingOr,
} from "../db/settings.ts";
import { assumeJob } from "../attendance/assume.ts";
import { jeopardyJob } from "../attendance/jeopardy.ts";
import { reminderJobs } from "../attendance/reminders.ts";
import { rearm, rearmStatement, type ArmedJob } from "../jobs/arm.ts";
import { POST_SIGNUP_JOB } from "./post.ts";

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
    await d.batch([moved, logged]);
    return { from, to, changed: true };
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

  // The ladder a session gets: the register when the evening is over, the
  // does-it-still-run check a day before, and the nudges. Both of the latter
  // read `settings`, so they are resolved *here* — before the batch — and the
  // batch is left with nothing in it that can throw for its own reasons.
  const standing = [
    assumeJob(sessionId, day.endsAt),
    await lockJob(env, gameDayId, day.startsAt),
    await jeopardyJob(env, sessionId, day.startsAt),
    ...(await reminderJobs(env, sessionId, day.startsAt)),
  ];

  // One commit. Opening seating and the jobs that carry the day to its end are
  // the same act: the `from === to` guard above means a transition that got
  // halfway cannot be run again to finish the job, so there is no halfway to be
  // in. Each key is derived from the session, so a replay writes none of them a
  // second time.
  await d.batch([
    moved,
    minted,
    logged,
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
          //
          // The attendance post is *not* here. It is armed by the signup post's
          // own job once the day has a thread, because `postAttendancePost`
          // sends into that thread if there is one and into the channel if
          // there is not — and under send-only a post in the wrong place cannot
          // be moved. Causal, rather than a `run_at` a minute out and a hope.
          id: `${POST_SIGNUP_JOB}:${gameDayId}`,
          kind: POST_SIGNUP_JOB,
          payload: { gameDayId },
          idempotencyKey: `${POST_SIGNUP_JOB}:${gameDayId}`,
          runAt: sql`(unixepoch())`,
        },
      ])
      .onConflictDoNothing(),
    rearmStatement(d, standing),
  ]);

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

export async function lockJob(
  env: Env,
  gameDayId: string,
  startsAt: number,
  now = Math.floor(Date.now() / 1000),
): Promise<ArmedJob> {
  const hours = await settingOr<number>(
    env,
    SETTING_KEYS.gameDayLockLeadHours,
    SETTING_DEFAULTS[SETTING_KEYS.gameDayLockLeadHours],
  );
  const lead = startsAt - hours * 3600;

  return {
    id: `${LOCK_JOB}:${gameDayId}`,
    kind: LOCK_JOB,
    payload: { gameDayId },
    // Never armed already due. A day opened for seating inside the lead time —
    // Wednesday evening for a Thursday, against a two-day default — would
    // otherwise lock itself in the same minute its signup post goes up, and
    // there is no LOCKED → SEATING edge and no way to mint the day again. Every
    // button on that post would answer "seating is closed" for ever. Firing the
    // jeopardy check or a reminder early is harmless; firing the lock early is
    // terminal, so short-notice seating runs to the evening itself instead.
    runAt: lead > now ? lead : startsAt,
  };
}

export async function armLock(env: Env, gameDayId: string, startsAt: number): Promise<void> {
  await rearm(db(env), [await lockJob(env, gameDayId, startsAt)]);
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

/** Whether this day is still taking seats. Only SEATING is. */
export function isSeating(day: { state: GameDayState }): boolean {
  return day.state === "SEATING";
}
