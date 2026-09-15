/**
 * Recurrence, because Discord cannot own it.
 *
 * Discord's weekly recurrence means exactly one weekday, and `count` and `end`
 * cannot be set externally at all — so a fortnightly game with twelve sessions
 * left is not expressible there. Orrey holds the rule and Discord holds two
 * events at a time.
 *
 * The rule is an **anchor plus an interval**, carried over from Hermuz as an
 * idea, and the anchor is usually in the *past* — commonly the first session
 * ever played. That is what makes "session 47" arithmetic rather than a counter
 * somebody has to maintain: the number is `first_session_number` plus the number
 * of intervals since the anchor, and it stays right however long Orrey was down.
 *
 * Pure on purpose. `from` and `timezone` are arguments, there is no `Env` and no
 * D1, so the materialiser above can be tested at a fixed instant.
 */
export interface Cadence {
  /** Unix seconds. Any occurrence of the rule; commonly long past. */
  anchor: number;
  intervalWeeks: number;
  /** The number the anchor's own occurrence had. */
  firstSessionNumber: number;
  /** Unix seconds. Occurrences at or after this are returned. */
  from: number;
  count: number;
  /** IANA zone. The step is taken in wall-clock time here, not in seconds. */
  timezone: string;
  durationMinutes: number;
}

export interface Occurrence {
  number: number;
  startsAt: number;
  endsAt: number;
}

export function occurrencesFrom(cadence: Cadence): Occurrence[] {
  const { anchor, intervalWeeks, firstSessionNumber, from, count, timezone, durationMinutes } =
    cadence;

  if (intervalWeeks <= 0) {
    throw new Error(`interval_weeks must be positive, not ${intervalWeeks}`);
  }
  if (count <= 0) return [];

  const wall = wallClockOf(anchor, timezone);
  const stepDays = intervalWeeks * 7;

  // Walk forward a whole interval at a time rather than dividing: the step is a
  // number of *days*, and days are not a fixed number of seconds. Dividing the
  // elapsed seconds would drift by an hour twice a year, which over a two-year
  // anchor is how a 19:00 game becomes an 18:00 game.
  //
  // A first estimate gets within an interval or two of `from`, so the loop is
  // short even for an anchor years back.
  let step = Math.max(0, Math.floor((from - anchor) / (stepDays * 86_400)));
  while (startOf(wall, step * stepDays, timezone) < from) step++;
  // The estimate can overshoot by one when a DST change lands between the two.
  while (step > 0 && startOf(wall, (step - 1) * stepDays, timezone) >= from) step--;

  const occurrences: Occurrence[] = [];
  for (let i = 0; i < count; i++) {
    const startsAt = startOf(wall, (step + i) * stepDays, timezone);
    occurrences.push({
      // The number counts intervals from the anchor, not items returned — so
      // skipping the past does not renumber the future.
      number: firstSessionNumber + step + i,
      startsAt,
      endsAt: startsAt + durationMinutes * 60,
    });
  }
  return occurrences;
}

/** The anchor as somebody in that zone would read it off a clock. */
export interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function wallClockOf(unixSeconds: number, timeZone: string): WallClock {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(unixSeconds * 1000));

  const read = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? "0");
  // `hour12: false` renders midnight as 24 in some runtimes; 24:00 is 00:00.
  const hour = read("hour") % 24;

  return {
    year: read("year"),
    month: read("month"),
    day: read("day"),
    hour,
    minute: read("minute"),
    second: read("second"),
  };
}

/**
 * The instant of the wall-clock time `days` after the anchor's date, in that
 * zone. This is the whole point of doing it this way: adding days to a calendar
 * date keeps 19:00 at 19:00 across a DST change, where adding seconds does not.
 */
function startOf(anchor: WallClock, days: number, timeZone: string): number {
  const date = new Date(Date.UTC(anchor.year, anchor.month - 1, anchor.day));
  date.setUTCDate(date.getUTCDate() + days);

  return instantOf(
    {
      year: date.getUTCFullYear(),
      month: date.getUTCMonth() + 1,
      day: date.getUTCDate(),
      hour: anchor.hour,
      minute: anchor.minute,
      second: anchor.second,
    },
    timeZone,
  );
}

/**
 * Wall clock back to an instant. There is no built-in for this, so: guess that
 * the zone is UTC, ask what offset that guess actually has, and correct. Twice,
 * because a guess landing on the far side of a DST change gets a neighbouring
 * offset and the second pass settles it.
 *
 * The hour that does not exist — 02:30 on a spring-forward Sunday — resolves to
 * the instant the clock jumps to, which is the same thing every calendar does.
 */
export function instantOf(wall: WallClock, timeZone: string): number {
  const asIfUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);

  let instant = asIfUtc;
  for (let pass = 0; pass < 2; pass++) {
    instant = asIfUtc - offsetMs(instant, timeZone);
  }
  return Math.floor(instant / 1000);
}

/** How far ahead of UTC the zone is at that instant, in milliseconds. */
function offsetMs(instant: number, timeZone: string): number {
  const wall = wallClockOf(Math.floor(instant / 1000), timeZone);
  const asIfUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
  return asIfUtc - instant;
}
