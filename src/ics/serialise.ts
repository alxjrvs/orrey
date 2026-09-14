/**
 * VCALENDAR and VEVENT, from rows and a zone.
 *
 * No bindings, no clock, no env: rows in, text out. That is what lets the route
 * above this be reviewed for what it selects rather than for what it prints.
 *
 * The fiddly parts of RFC 5545 are all here and all tested, because every one of
 * them fails silently in a calendar client — an over-long line, a comma nobody
 * escaped, or an LF where a CRLF belongs does not raise an error, it produces an
 * event that quietly is not there.
 */
export interface IcsEvent {
  /** `eventIdFor(sessionId)` with an `@orrey` suffix — the Google event's identity. */
  uid: string;
  sequence: number;
  startsAt: number;
  endsAt: number;
  summary: string;
  description?: string | null;
  location?: string | null;
  /**
   * A cancelled session is emitted with `CANCELLED` rather than dropped.
   * Dropping it leaves the event in every subscriber's calendar for ever, which
   * is the opposite of calling it off.
   */
  status: "CONFIRMED" | "TENTATIVE" | "CANCELLED";
  url?: string | null;
}

export interface Calendar {
  name: string;
  timeZone: string;
  events: IcsEvent[];
  /** The instant the feed was generated. Passed in; nothing here reads a clock. */
  stampedAt: number;
}

const PRODID = "-//Orrey//Orrey Scheduling//EN";

export function serialise(calendar: Calendar): string {
  const years = yearsCovered(calendar.events, calendar.stampedAt);

  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `PRODID:${PRODID}`,
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${escapeText(calendar.name)}`,
    `X-WR-TIMEZONE:${calendar.timeZone}`,
    ...vtimezone(calendar.timeZone, years),
    ...calendar.events.flatMap((event) => vevent(event, calendar.timeZone, calendar.stampedAt)),
    "END:VCALENDAR",
  ];

  // CRLF, and a trailing one: RFC 5545 §3.1 says every content line ends with
  // one, the last included.
  return lines.flatMap(fold).join("\r\n") + "\r\n";
}

function vevent(event: IcsEvent, timeZone: string, stampedAt: number): string[] {
  return [
    "BEGIN:VEVENT",
    `UID:${event.uid}`,
    `DTSTAMP:${utcStamp(stampedAt)}`,
    `DTSTART;TZID=${timeZone}:${localStamp(event.startsAt, timeZone)}`,
    `DTEND;TZID=${timeZone}:${localStamp(event.endsAt, timeZone)}`,
    `SUMMARY:${escapeText(event.summary)}`,
    ...(event.description ? [`DESCRIPTION:${escapeText(event.description)}`] : []),
    ...(event.location ? [`LOCATION:${escapeText(event.location)}`] : []),
    ...(event.url ? [`URL:${event.url}`] : []),
    `STATUS:${event.status}`,
    `SEQUENCE:${event.sequence}`,
    "END:VEVENT",
  ];
}

/**
 * The zone, defined by the transitions it actually has in the years the feed
 * covers — `RDATE`s, not an `RRULE`.
 *
 * A feed over a bounded window does not need a rule that extrapolates for ever,
 * and a rule is the part of `VTIMEZONE` that is hardest to get right and
 * impossible to assert exactly. A list of instants is a thing a test can check
 * one by one, and it is read out of `Intl` rather than from a table this repo
 * would have to maintain against every government that moves its clocks.
 */
export function vtimezone(timeZone: string, years: number[]): string[] {
  const changes = transitionsIn(timeZone, years);
  if (changes.length === 0) {
    // A zone with no transitions in the window is still a zone, and a DTSTART
    // whose TZID names nothing is a DTSTART a client reads as floating.
    const offset = offsetAt(timeZone, Date.UTC(years[0] ?? 2026, 0, 1) / 1000);
    return [
      "BEGIN:VTIMEZONE",
      `TZID:${timeZone}`,
      "BEGIN:STANDARD",
      `DTSTART:${localStamp(Math.floor(Date.UTC(years[0] ?? 2026, 0, 1) / 1000), timeZone)}`,
      `TZOFFSETFROM:${offset}`,
      `TZOFFSETTO:${offset}`,
      "TZNAME:STD",
      "END:STANDARD",
      "END:VTIMEZONE",
    ];
  }

  const daylight = changes.filter((change) => change.into > change.from);
  const standard = changes.filter((change) => change.into <= change.from);

  return [
    "BEGIN:VTIMEZONE",
    `TZID:${timeZone}`,
    ...block("DAYLIGHT", daylight, timeZone),
    ...block("STANDARD", standard, timeZone),
    "END:VTIMEZONE",
  ];
}

interface Transition {
  at: number;
  from: string;
  into: string;
}

function block(kind: "DAYLIGHT" | "STANDARD", changes: Transition[], timeZone: string): string[] {
  const first = changes[0];
  if (!first) return [];
  return [
    `BEGIN:${kind}`,
    `DTSTART:${localStamp(first.at, timeZone)}`,
    `TZOFFSETFROM:${first.from}`,
    `TZOFFSETTO:${first.into}`,
    `TZNAME:${kind === "DAYLIGHT" ? "DST" : "STD"}`,
    ...changes.slice(1).map((change) => `RDATE:${localStamp(change.at, timeZone)}`),
    `END:${kind}`,
  ];
}

/**
 * Every offset change in those years, found by bisection on the hour.
 *
 * Transitions land on an hour boundary everywhere that has them, so a daily scan
 * plus a binary search inside the day that changed is exact and costs a few
 * hundred `Intl` reads a year — for a feed that is cached for fifteen minutes.
 */
function transitionsIn(timeZone: string, years: number[]): Transition[] {
  const found: Transition[] = [];
  for (const year of years) {
    let cursor = Math.floor(Date.UTC(year, 0, 1) / 1000);
    const end = Math.floor(Date.UTC(year + 1, 0, 1) / 1000);
    let previous = offsetAt(timeZone, cursor);

    while (cursor < end) {
      const next = Math.min(cursor + 86_400, end);
      const offset = offsetAt(timeZone, next);
      if (offset !== previous) {
        found.push({ at: exactly(timeZone, cursor, next, previous), from: previous, into: offset });
        previous = offset;
      }
      cursor = next;
    }
  }
  return found;
}

/** The first second with the new offset, between two instants known to differ. */
function exactly(timeZone: string, low: number, high: number, before: string): number {
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    if (offsetAt(timeZone, middle) === before) low = middle;
    else high = middle;
  }
  return high;
}

/** `+0100`, as `TZOFFSETFROM`/`TZOFFSETTO` want it. */
export function offsetAt(timeZone: string, unixSeconds: number): string {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone, timeZoneName: "longOffset" })
    .formatToParts(new Date(unixSeconds * 1000))
    .find((part) => part.type === "timeZoneName");

  // "GMT+01:00", or plain "GMT" for the zero offset.
  const raw = parts?.value ?? "GMT";
  const match = /GMT([+-])(\d{2}):(\d{2})/.exec(raw);
  if (!match) return "+0000";
  return `${match[1]}${match[2]}${match[3]}`;
}

function yearsCovered(events: IcsEvent[], stampedAt: number): number[] {
  const stamps = events.length === 0 ? [stampedAt] : events.map((event) => event.startsAt);
  const years = stamps.map((stamp) => new Date(stamp * 1000).getUTCFullYear());
  const from = Math.min(...years);
  const to = Math.max(...years);

  const all: number[] = [];
  for (let year = from; year <= to; year++) all.push(year);
  return all;
}

/** `20260920T190000Z`. */
export function utcStamp(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

/** `20260920T200000`, as the wall clock reads in that zone. */
export function localStamp(unixSeconds: number, timeZone: string): string {
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

  const read = (type: string) => parts.find((part) => part.type === type)?.value ?? "00";
  // `hour12: false` renders midnight as 24 in some runtimes; 24:00 is 00:00.
  const hour = String(Number(read("hour")) % 24).padStart(2, "0");
  return `${read("year")}${read("month")}${read("day")}T${hour}${read("minute")}${read("second")}`;
}

/**
 * `\\`, `\,`, `\;` and `\n`, in that order.
 *
 * The backslash goes first or it escapes the escapes. A campaign called "Blades,
 * in the Dark" is the ordinary case, not a contrived one.
 */
export function escapeText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r\n|\r|\n/g, "\\n");
}

/**
 * 75 **octets**, not 75 characters.
 *
 * RFC 5545 §3.1 counts octets, and it also says a multi-octet character must not
 * be split across a fold. Counting characters puts the break mid-sequence for
 * any name with an accent in it, and what the client shows then is a replacement
 * character or nothing at all.
 */
export function fold(line: string): string[] {
  const bytes = new TextEncoder().encode(line);
  if (bytes.length <= 75) return [line];

  const out: string[] = [];
  let start = 0;
  // 75 on the first line; 74 after, because the continuation's leading space is
  // itself an octet of the folded line.
  let limit = 75;

  while (start < bytes.length) {
    let end = Math.min(start + limit, bytes.length);
    // Back off to a code-point boundary: 0b10xxxxxx is a continuation octet, and
    // breaking on one severs the character it belongs to.
    while (end > start && end < bytes.length && ((bytes[end] as number) & 0xc0) === 0x80) end--;

    const chunk = new TextDecoder().decode(bytes.slice(start, end));
    out.push(out.length === 0 ? chunk : ` ${chunk}`);
    start = end;
    limit = 74;
  }

  return out;
}
