import type { Env } from "../env.ts";
import { SETTING_DEFAULTS, SETTING_KEYS, settingOr } from "../db/settings.ts";
import { instantOf } from "../campaigns/recurrence.ts";
import { agendaBetween, type AgendaRow } from "./agenda.ts";

/**
 * A month, as a grid.
 *
 * This is what `p6/1` took a *window* for rather than "the next N": a month view
 * is the same query with `from` and `to` set to the month's bounds, and the
 * bounds a grid needs are not the month's — they are the six weeks it draws,
 * leading days of the month before and trailing days of the month after
 * included. A grid that asked for the month proper would render those cells
 * empty and be quietly wrong about the last week of March.
 *
 * **Six rows, always.** A month that would fit in five still gets six, so the
 * grid does not change height when somebody steps between months. A layout that
 * reflows under the pointer is one people misclick.
 *
 * This is the one screen in phase 6 with no design behind it at all —
 * `design/readme.md` lists the console's month view under "Open questions for
 * the author" as not drawn. So it is built from tokens and existing primitives
 * only. If the author draws it later, this is what gets replaced, and it is
 * small enough that that is cheap.
 */
const ROWS = 6;
const COLUMNS = 7;

export interface MonthCell {
  /** `YYYY-MM-DD` in the guild's zone. */
  day: string;
  /** Whether it belongs to the month asked for, or to the one either side of it. */
  inMonth: boolean;
  sessions: AgendaRow[];
}

export interface Month {
  year: number;
  /** 1–12, as a person says it, not as `Date` does. */
  month: number;
  timeZone: string;
  from: number;
  to: number;
  /** Six rows of seven. Always, whatever the month would have fitted in. */
  weeks: MonthCell[][];
}

/**
 * The grid's bounds: back to the Monday on or before the first, forward
 * forty-two days.
 *
 * Days are stepped as **calendar days in the guild's zone**, never as 86,400
 * seconds. A week that contains a DST change is 167 or 169 hours long, and
 * arithmetic that assumes otherwise puts a Sunday-evening session in Saturday's
 * cell twice a year — the same trap `docs/GOTCHAS.md` records for the
 * materialiser's week stepping.
 */
export function monthWindow(
  year: number,
  month: number,
  timeZone: string,
): { from: number; to: number; days: string[] } {
  const first = new Date(Date.UTC(year, month - 1, 1));
  // Monday is 0 here: `getUTCDay()` is 0 for Sunday, and a UK calendar starts on
  // a Monday.
  const back = (first.getUTCDay() + 6) % 7;

  const days: string[] = [];
  const cursor = new Date(Date.UTC(year, month - 1, 1 - back));
  for (let i = 0; i < ROWS * COLUMNS; i++) {
    days.push(isoOf(cursor));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  const from = midnightIn(days[0] as string, timeZone);
  // Half-open: the instant the day *after* the last cell begins. A session at
  // 23:30 on the final Sunday belongs in that cell, and a bound at its midnight
  // would drop it.
  const to = midnightIn(isoOf(cursor), timeZone);

  return { from, to, days };
}

export async function monthGrid(
  env: Env,
  year: number,
  month: number,
  asOf: Date,
  timeZone?: string,
): Promise<Month> {
  const zone =
    timeZone ??
    (await settingOr<string>(env, SETTING_KEYS.timezone, SETTING_DEFAULTS[SETTING_KEYS.timezone]));

  const { from, to, days } = monthWindow(year, month, zone);
  const { rows } = await agendaBetween(env, from, to, asOf);

  const by = new Map<string, AgendaRow[]>();
  for (const row of rows) {
    // The day in the **guild's** zone. A session at 23:30 on the 30th is on the
    // 30th for the table, whatever the reader's laptop says — and if this used
    // the server's zone, two people would see the same session in two cells.
    const day = dayIn(row.startsAt, zone);
    const cell = by.get(day);
    if (cell) cell.push(row);
    else by.set(day, [row]);
  }

  const prefix = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-`;
  const weeks: MonthCell[][] = [];
  for (let week = 0; week < ROWS; week++) {
    weeks.push(
      days.slice(week * COLUMNS, week * COLUMNS + COLUMNS).map((day) => ({
        day,
        inMonth: day.startsWith(prefix),
        sessions: by.get(day) ?? [],
      })),
    );
  }

  return { year, month, timeZone: zone, from, to, weeks };
}

/**
 * `YYYY-MM-DD` for an instant, in a zone.
 *
 * `p6/2` grows the same function on `AgendaRow` for the agenda's day headers.
 * This branch forks off `p6/1` and deliberately does not reach across that fork
 * for it; once both are in `main` they collapse into one.
 */
export function dayIn(startsAt: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(startsAt * 1000));
}

function isoOf(date: Date): string {
  return `${String(date.getUTCFullYear()).padStart(4, "0")}-${String(
    date.getUTCMonth() + 1,
  ).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

function midnightIn(day: string, timeZone: string): number {
  const [year, month, date] = day.split("-").map(Number) as [number, number, number];
  return instantOf({ year, month, day: date, hour: 0, minute: 0, second: 0 }, timeZone);
}
