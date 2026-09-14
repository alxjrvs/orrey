import { instantOf } from "../campaigns/recurrence.ts";

/**
 * One date per line.
 *
 * A Discord modal takes five text inputs and a poll takes ten dates, so the
 * proposal is a single paragraph box, one date per line. This reads it.
 *
 * **It reaches for nothing.** No clock, no database, no env — the zone arrives
 * as an argument like every other ambient value in this repo's pure functions,
 * and "now" arrives as one too, because a bare year is relative to something.
 *
 * The zone is the whole reason this is hard. Unix seconds are UTC; a person
 * typing "Thu 7pm" means seven in the evening *where they play*, and those are
 * not the same number on the two Sundays a year when the offset moves. So the
 * wall clock is read out of the text and converted through the guild's zone,
 * using the same `instantOf` the recurrence stepper uses — one DST
 * implementation in the repo, not two.
 *
 * Lines it cannot read come back **verbatim and unswallowed**. Somebody typed
 * them, and answering "3 of your 4 dates were fine" while silently dropping the
 * fourth is how a poll ends up missing the date everybody wanted.
 */
export const MAX_DATES = 10;

export interface ParsedDate {
  startsAt: number;
  endsAt: number;
  /** The line it came from, so a confirmation can quote what was understood. */
  source: string;
}

export type ParseResult =
  | { ok: true; dates: ParsedDate[] }
  | { ok: false; unreadable: string[]; tooMany?: number };

export function parseDates({
  text,
  timeZone,
  durationSeconds,
  now,
}: {
  text: string;
  timeZone: string;
  /** Copied from whatever the poll is about — a session keeps its own length. */
  durationSeconds: number;
  /** What a line with no year means. */
  now: Date;
}): ParseResult {
  // Blank lines are how people space a list out. They are not an answer and not
  // an error.
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (lines.length > MAX_DATES) {
    return { ok: false, unreadable: [], tooMany: lines.length };
  }

  const dates: ParsedDate[] = [];
  const unreadable: string[] = [];

  for (const line of lines) {
    const wall = readLine(line, now, timeZone);
    if (!wall) {
      unreadable.push(line);
      continue;
    }
    const startsAt = instantOf(wall, timeZone);
    dates.push({ startsAt, endsAt: startsAt + durationSeconds, source: line });
  }

  // All or nothing. Nine good dates and one typo should not cost somebody the
  // nine — they get the typo back and resubmit the lot.
  if (unreadable.length > 0) return { ok: false, unreadable };
  return { ok: true, dates };
}

/**
 * What one line is allowed to look like.
 *
 * Deliberately narrow. A parser that guesses is a parser that puts a poll on the
 * wrong day and tells nobody, so anything it is not sure of comes back as
 * unreadable and the person retypes it. The shapes are the ones people actually
 * write in a Discord box:
 *
 *   2026-10-01 19:00        2026-10-01 7pm
 *   1 Oct 19:00             Oct 1 7:30pm
 *   Thu 3 Dec 20:00
 *
 * A line with no year means the next occurrence of that date — typing "1 Oct" in
 * November means next year, and saying so is better than putting the poll eleven
 * months in the past.
 */
function readLine(line: string, now: Date, timeZone: string) {
  const time = readTime(line);
  if (!time) return undefined;

  const rest = line.slice(0, time.index).trim();
  const date = readDate(rest, now, timeZone);
  if (!date) return undefined;

  return { ...date, hour: time.hour, minute: time.minute, second: 0 };
}

/** `19:00`, `7pm`, `7.30pm` — always at the end of the line. */
function readTime(line: string) {
  const match = /(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)?\s*$/i.exec(line);
  if (!match) return undefined;

  let hour = Number(match[1]);
  const minute = Number(match[2] ?? 0);
  const meridiem = match[3]?.toLowerCase();

  if (minute > 59) return undefined;
  if (meridiem) {
    if (hour < 1 || hour > 12) return undefined;
    if (meridiem === "pm" && hour !== 12) hour += 12;
    if (meridiem === "am" && hour === 12) hour = 0;
  } else if (hour > 23) {
    return undefined;
  } else if (!match[2]) {
    // A bare number with no colon and no am/pm is not a time anybody meant to
    // write. "1 Oct 7" could be seven in the morning or a typo, and guessing is
    // how a poll lands twelve hours out.
    return undefined;
  }

  return { hour, minute, index: match.index };
}

const MONTHS = [
  "jan", "feb", "mar", "apr", "may", "jun",
  "jul", "aug", "sep", "oct", "nov", "dec",
];

function readDate(text: string, now: Date, timeZone: string) {
  // An ISO date says everything, including the year.
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (iso) {
    return { year: Number(iso[1]), month: Number(iso[2]), day: Number(iso[3]) };
  }

  // `1 Oct`, `Oct 1`, `Thu 3 Dec`, optionally with a year. A leading weekday is
  // read and thrown away: it is how people write dates, and checking it against
  // the date would mean refusing a line over a detail Orrey can compute.
  const stripped = text.replace(/^[a-z]{3,9}[,.]?\s+/i, (match) =>
    MONTHS.includes(match.trim().slice(0, 3).toLowerCase()) ? match : "",
  );

  const dayFirst = /^(\d{1,2})\s+([a-z]{3,9})\.?(?:\s+(\d{4}))?$/i.exec(stripped);
  const monthFirst = /^([a-z]{3,9})\.?\s+(\d{1,2})(?:\s+(\d{4}))?$/i.exec(stripped);

  const parts = dayFirst
    ? { day: Number(dayFirst[1]), month: dayFirst[2] ?? "", year: dayFirst[3] }
    : monthFirst
      ? { day: Number(monthFirst[2]), month: monthFirst[1] ?? "", year: monthFirst[3] }
      : undefined;
  if (!parts) return undefined;

  const month = MONTHS.indexOf(parts.month.slice(0, 3).toLowerCase()) + 1;
  if (month === 0) return undefined;
  if (parts.day < 1 || parts.day > 31) return undefined;

  if (parts.year) return { year: Number(parts.year), month, day: parts.day };

  // No year: the next time this date comes round, read in the guild's zone
  // rather than the server's.
  const here = wallYearAndMonth(now, timeZone);
  const year =
    month < here.month || (month === here.month && parts.day < here.day)
      ? here.year + 1
      : here.year;
  return { year, month, day: parts.day };
}

function wallYearAndMonth(now: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const read = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? "0");
  return { year: read("year"), month: read("month"), day: read("day") };
}
