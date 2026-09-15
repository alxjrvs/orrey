import { DurableObject } from "cloudflare:workers";
import { and, eq, sql } from "drizzle-orm";
import type { Env } from "../env.ts";
import { db, schema } from "../db/index.ts";
import { rememberUser } from "../db/users.ts";
import { attendanceRows } from "../attendance/rows.ts";
import { crossesThreshold, quorumOf } from "../attendance/quorum.ts";
import { loadProjectionTarget } from "../projection/target.ts";
import {
  capacityOf,
  claimSeat,
  signupsForDay,
  withdraw,
  type DaySignup,
} from "../game-days/signups.ts";
import { promoteFromWaitlist } from "../game-days/promote.ts";
import type { AttendanceRow } from "../attendance/render.ts";
import type { InteractionUser } from "../discord/types.ts";

/**
 * One per session. Six people clicking "In" at once must not each read the same
 * tally and each render a different one: the click that crosses quorum has to
 * be the click that renders the confirmed state.
 *
 * The Durable Object's input gate alone is not enough here — it reopens across
 * non-storage I/O, and every read and write in these methods is a D1 call. So
 * the work is chained explicitly, and each method returns the state it just
 * wrote, which is what the interaction response renders.
 */
export class SessionLock extends DurableObject<Env> {
  private chain: Promise<unknown> = Promise.resolve();

  private serialise<T>(work: () => Promise<T>): Promise<T> {
    const next = this.chain.then(work);
    this.chain = next.catch(() => undefined);
    return next as Promise<T>;
  }

  /** What this person now says, and everything the post must show afterwards. */
  async setIntent({ sessionId, actor, intent }: AttendanceIntent): Promise<AttendanceRow[]> {
    return this.serialise(async () => {
      // Identity is the Discord id; the names are a cache this refreshes.
      await rememberUser(this.env, actor);

      await db(this.env)
        .insert(schema.attendance)
        .values({ sessionId, userId: actor.id, intent, updatedAt: sql`(unixepoch())` })
        .onConflictDoUpdate({
          target: [schema.attendance.sessionId, schema.attendance.userId],
          set: { intent, updatedAt: sql`(unixepoch())` },
        });

      return this.settle(sessionId);
    });
  }

  /**
   * A free-text note against this person's row, whether or not they have said
   * whether they are coming. An empty note clears it.
   *
   * The text is normalised on the way in rather than on the way out: it is
   * rendered inline on a post Orrey can never edit, so a newline would break
   * that post's layout permanently.
   *
   * `updated_at` is deliberately left alone on an existing row. The post lists
   * people in the order they answered, and adding a note is not answering —
   * bumping it would shuffle someone to the end of their own list for saying
   * "running late".
   */
  async setNote({ sessionId, actor, note }: AttendanceNote): Promise<AttendanceRow[]> {
    return this.serialise(async () => {
      await rememberUser(this.env, actor);
      const cleaned = normaliseNote(note);

      await db(this.env)
        .insert(schema.attendance)
        .values({ sessionId, userId: actor.id, note: cleaned })
        .onConflictDoUpdate({
          target: [schema.attendance.sessionId, schema.attendance.userId],
          set: { note: cleaned },
        });

      return this.settle(sessionId);
    });
  }

  /**
   * Flip one person's attendance, and say it was a person who decided.
   *
   * Behind the same lock as everything else that touches this session's rows: an
   * organiser tapping four toggles quickly is four read-modify-writes, and each
   * one has to render the register the previous one left.
   */
  async toggleAttended({
    sessionId,
    userId,
  }: {
    sessionId: string;
    userId: string;
  }): Promise<void> {
    return this.serialise(async () => {
      const current = await db(this.env)
        .select({ attended: schema.attendance.attended })
        .from(schema.attendance)
        .where(
          and(
            eq(schema.attendance.sessionId, sessionId),
            eq(schema.attendance.userId, userId),
          ),
        )
        .get();

      const attended = current?.attended === 1 ? 0 : 1;

      await db(this.env)
        .insert(schema.attendance)
        .values({ sessionId, userId, attended, attendedSource: "gm" })
        .onConflictDoUpdate({
          target: [schema.attendance.sessionId, schema.attendance.userId],
          // `gm` is the point: it is what stops a re-run of the assume job
          // putting Orrey's guess back over somebody's answer.
          set: { attended, attendedSource: "gm" },
        });
    });
  }

  /**
   * Refresh: no write, but the same queue, so a refresh landing between two
   * clicks reads a settled state rather than a half-written one.
   */
  async readIntents(sessionId: string): Promise<AttendanceRow[]> {
    return this.serialise(() => this.settle(sessionId));
  }

  /**
   * A seat at a game day, taken by the same object under a different name.
   *
   * No new class and no new binding: the lock is per clickable thing, and a day
   * and a session are different things, clicked by different people at different
   * times. `idFromName(gameDayId)` is a different object from
   * `idFromName(sessionId)` even though both come from `SESSION_LOCK`, and a new
   * class would be a wrangler migration bought for nothing.
   *
   * The *write* does not need this lock — `claimSeat` decides capacity inside a
   * single INSERT, so two clicks for one seat serialise in D1 whether or not
   * anything else does. What needs it is the pair: the click that takes the last
   * seat has to be the click that renders the full post, and `p5/7`'s promotion
   * has to run in the same chain as the withdrawal that freed the seat, or two
   * people going Out at once promote the same person twice.
   */
  async takeSeat({ gameDayId, actor, prefer }: SeatClick): Promise<SeatState> {
    return this.serialise(async () => {
      // Identity is the Discord id; the names are a cache this refreshes. It
      // also has to happen before the claim: `signups.user_id` references
      // `users`, and somebody clicking for the first time has no row yet.
      await rememberUser(this.env, actor);
      await claimSeat(this.env, gameDayId, actor.id, { prefer });
      return this.seats(gameDayId);
    });
  }

  /**
   * Giving the place back, and whoever the freed seat lets in.
   *
   * The promotion runs inside this chain rather than after it, which is the
   * reason the chain exists at all here: two people going Out at once, each
   * promoting outside the lock, both read "one seat free" and both promote the
   * head of the queue.
   */
  async leaveSeat({ gameDayId, actor }: Omit<SeatClick, "prefer">): Promise<SeatState> {
    return this.serialise(async () => {
      await rememberUser(this.env, actor);
      const gave = await withdraw(this.env, gameDayId, actor.id);
      // Nothing was given back, so nothing came free. Promoting here would be
      // reading a table that has not changed.
      if (gave === "withdrawn") await promoteFromWaitlist(this.env, gameDayId);
      return this.seats(gameDayId);
    });
  }

  /** Refresh, on the same queue and for the same reason as `readIntents`. */
  async readSeats(gameDayId: string): Promise<SeatState> {
    return this.serialise(() => this.seats(gameDayId));
  }

  private async seats(gameDayId: string): Promise<SeatState> {
    return {
      signups: await signupsForDay(this.env, gameDayId),
      capacity: await capacityOf(this.env, gameDayId),
    };
  }

  /**
   * Read the rows back, and confirm the session if this click is the one that
   * crossed the threshold.
   *
   * It happens here, inside the lock, because that is the only place where "the
   * count after my write" is a real number rather than a guess — six people
   * clicking In at once must produce one crossing, not six.
   *
   * Dropping back below afterwards does **not** un-confirm. #28 is explicit:
   * whether a confirmed session is still on once somebody drops out is the
   * organiser's call, so the post says what happened and Orrey decides nothing.
   */
  private async settle(sessionId: string): Promise<AttendanceRow[]> {
    const rows = await attendanceRows(this.env, sessionId);

    const target = await loadProjectionTarget(this.env, sessionId);
    if (!target) return rows;

    if (crossesThreshold(quorumOf(target, rows), target)) {
      const d = db(this.env);
      await d.batch([
        d
          .update(schema.sessions)
          .set({ state: "CONFIRMED", updatedAt: sql`(unixepoch())` })
          .where(eq(schema.sessions.id, sessionId)),

        // The notice is a job rather than a post made here, and that is a
        // deliberate reading of #28. A click has three seconds to answer, and
        // the thing that must happen inside them is the rewrite of its own
        // message — which it does. Spending them on a second Discord call to
        // post the notice risks the response Discord is actually waiting for.
        //
        // So: armed in the same batch as the confirmation, posted by the next
        // minute's drain, and inspectable and re-runnable in between like every
        // other piece of time-shifted work in this repo.
        d
          .insert(schema.jobs)
          .values({
            id: `session.confirmed-notice:${sessionId}`,
            kind: "session.confirmed-notice",
            payload: { sessionId },
            idempotencyKey: `session.confirmed-notice:${sessionId}`,
            runAt: sql`(unixepoch())`,
          })
          .onConflictDoNothing(),
      ]);
    }

    return rows;
  }

  /**
   * The phase-0 exit criterion: a click that reaches D1 and comes back with the
   * tally to render. Phase 3 replaces this with intent, quorum and jeopardy —
   * the shape, read-modify-write behind the lock, is the shape they will use.
   */
  async click(target: string, actor: InteractionUser): Promise<SmokeTally> {
    return this.serialise(async () => {
      await rememberUser(this.env, actor);

      const key = tallyKey(target);
      const current = (await tally(this.env, key)) ?? { clicks: 0 };
      const next: SmokeTally = {
        clicks: current.clicks + 1,
        lastBy: actor.global_name ?? actor.username,
        asOf: new Date().toISOString(),
      };

      await db(this.env)
        .insert(schema.settings)
        .values({ key, value: next })
        .onConflictDoUpdate({
          target: schema.settings.key,
          set: { value: next, updatedAt: sql`(unixepoch())` },
        });

      return next;
    });
  }
}

/**
 * Six people clicking In at once is the case this exists for. Each click reads,
 * writes and re-renders behind the same chain, and the rows it returns are the
 * rows that click wrote — so the response can render what was just written
 * without going back to look, and two clicks can never render the same tally.
 */
export interface AttendanceIntent {
  sessionId: string;
  actor: InteractionUser;
  intent: "in" | "out" | "maybe";
}

export interface SeatClick {
  gameDayId: string;
  actor: InteractionUser;
  prefer?: "seat" | "waitlist";
}

/** Everything the signup post renders, as of the click that just wrote it. */
export interface SeatState {
  signups: DaySignup[];
  capacity: number | null;
}

export interface AttendanceNote {
  sessionId: string;
  actor: InteractionUser;
  note: string;
}

/** One line, no surprises, short enough to sit beside a name. */
export function normaliseNote(note: string): string | null {
  const cleaned = note.replace(/\s+/g, " ").trim().slice(0, 140);
  return cleaned.length > 0 ? cleaned : null;
}

export interface SmokeTally {
  clicks: number;
  lastBy?: string;
  asOf?: string;
}

export function tallyKey(target: string): string {
  return `smoke:${target}`;
}

export async function tally(env: Env, key: string): Promise<SmokeTally | undefined> {
  const row = await db(env)
    .select()
    .from(schema.settings)
    .where(eq(schema.settings.key, key))
    .get();
  return row?.value as SmokeTally | undefined;
}
