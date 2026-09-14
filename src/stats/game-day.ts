import { asc, eq, inArray } from "drizzle-orm";
import type { Env } from "../env.ts";
import { db, schema } from "../db/index.ts";

/**
 * What a game day's signups and register say about how it went.
 *
 * The same shape as the campaign half — a pure compute over rows, a loader
 * beside it — and the same rule about nulls. What makes this file its own PR is
 * that **the two kinds of day answer differently**, and anything that flattens
 * them into one number is the bug it exists to avoid.
 *
 * A `multi` day is seated at the day level and has no capacity of its own, so
 * its fill rate is **null**: not zero, which would read as "nobody came", and
 * not one, which would read as "full". A `single` day that nobody signed up for
 * has a fill rate of **zero**, which is a real answer about a real evening.
 */

export interface DayRow {
  gameDayId: string;
  kind: "single" | "multi";
  state: string;
  title: string | null;
  startsAt: number;
  /** The day's own column. Never the game's — the day copied what it needed. */
  capacity: number | null;
  waitlistAtLock: number | null;
}

export interface SeatRow {
  gameDayId: string;
  state: "in" | "waitlisted" | "out";
}

export interface TableRow {
  gameDayId: string;
  tablesPlayed: string | null;
}

export interface DayStats {
  gameDayId: string;
  title: string | null;
  startsAt: number;
  kind: "single" | "multi";
  seated: number;
  capacity: number | null;
  /**
   * `seated / capacity`, or **null** on a day with no capacity to be full of.
   * A multi day is always null; a single day with an empty roster is zero.
   */
  fillRate: number | null;
  /**
   * How deep the queue was when the table settled, or **null** on a day that has
   * not locked. Null is "not yet", never "nobody queued".
   */
  waitlistDepth: number | null;
  /**
   * How many people recorded what they played. **Null on a single day**: the
   * whole day is one game there, and the field only exists on a multi day.
   */
  tablesRecorded: number | null;
}

export function computeDayStats(input: {
  day: DayRow;
  seats: SeatRow[];
  tables: TableRow[];
}): DayStats | null {
  const { day } = input;

  // A day that was called off reports nothing at all. Its signups are a list of
  // people who would have come, and averaging that into a fill rate would put a
  // day nobody played into the denominator of how full days get.
  if (day.state === "CANCELLED") return null;

  const seated = input.seats.filter((seat) => seat.state === "in").length;

  return {
    gameDayId: day.gameDayId,
    title: day.title,
    startsAt: day.startsAt,
    kind: day.kind,
    seated,
    capacity: day.capacity,
    // Null rather than a division by nothing. `capacity` is the day's column:
    // nothing here reads `games` for a number the day already copied.
    fillRate: day.capacity === null || day.capacity === 0 ? null : seated / day.capacity,
    waitlistDepth: day.waitlistAtLock,
    tablesRecorded:
      day.kind === "single"
        ? null
        : input.tables.filter((row) => row.tablesPlayed !== null && row.tablesPlayed !== "")
            .length,
  };
}

export async function loadDayStats(env: Env, gameDayId: string): Promise<DayStats | null> {
  const [only] = await loadDaysStats(env, [gameDayId]);
  return only ?? null;
}

/**
 * Every day at once, for the page that lists them.
 *
 * A cancelled day is absent from the result rather than present as a row of
 * nulls: the page averages across what comes back, and a day nobody played
 * belongs in neither the numerator nor the denominator.
 */
export async function loadDaysStats(env: Env, gameDayIds?: string[]): Promise<DayStats[]> {
  const d = db(env);

  const days = gameDayIds
    ? await d
        .select()
        .from(schema.gameDays)
        .where(inArray(schema.gameDays.id, gameDayIds.slice(0, 90)))
        .orderBy(asc(schema.gameDays.startsAt))
        .all()
    : await d.select().from(schema.gameDays).orderBy(asc(schema.gameDays.startsAt)).all();

  const out: DayStats[] = [];
  for (const day of days) {
    const seats = await d
      .select({ state: schema.signups.state })
      .from(schema.signups)
      .where(eq(schema.signups.targetId, day.id))
      .all();

    // `tables_played` hangs off the day's session, which is the row attendance
    // is keyed by.
    const tables = await d
      .select({ tablesPlayed: schema.attendance.tablesPlayed })
      .from(schema.attendance)
      .innerJoin(schema.sessions, eq(schema.attendance.sessionId, schema.sessions.id))
      .where(eq(schema.sessions.gameDayId, day.id))
      .all();

    const stats = computeDayStats({
      day: {
        gameDayId: day.id,
        kind: day.kind,
        state: day.state,
        title: day.title,
        startsAt: day.startsAt,
        capacity: day.capacity,
        waitlistAtLock: day.waitlistAtLock,
      },
      seats: seats.map((seat) => ({ gameDayId: day.id, state: seat.state })),
      tables: tables.map((row) => ({ gameDayId: day.id, tablesPlayed: row.tablesPlayed })),
    });
    if (stats) out.push(stats);
  }

  return out;
}
