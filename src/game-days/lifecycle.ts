import { eq, sql } from "drizzle-orm";
import type { Env } from "../env.ts";
import { db, schema } from "../db/index.ts";
import { armAssume } from "../attendance/assume.ts";
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
  //
  // `game-day.lock` is the fourth job a SEATING day wants, and it is armed one
  // PR up alongside the handler that runs it. Arming a job kind `runJob` does
  // not know is how a row retries into `last_error` until that PR lands.
  await armAssume(env, sessionId, day.endsAt);

  return { from, to, changed: true, sessionId };
}

/** Whether this day is still taking seats. Only SEATING is. */
export function isSeating(day: { state: GameDayState }): boolean {
  return day.state === "SEATING";
}
