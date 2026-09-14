import { describe, expect, it } from "vitest";
import { MAX_DATES, parseDates } from "../src/polls/parse-dates.ts";

/**
 * One date per line, read in the guild's zone. Nothing here touches the clock or
 * the database — "now" and the zone are arguments, which is the point of the
 * slice.
 */
const ZONE = "Europe/London";
const NOW = new Date("2026-09-14T12:00:00Z");
const FOUR_HOURS = 4 * 3600;

function parse(text: string, over: { timeZone?: string; now?: Date } = {}) {
  return parseDates({
    text,
    timeZone: over.timeZone ?? ZONE,
    durationSeconds: FOUR_HOURS,
    now: over.now ?? NOW,
  });
}

function starts(result: ReturnType<typeof parse>): number[] {
  if (!result.ok) throw new Error(`expected a clean parse: ${JSON.stringify(result)}`);
  return result.dates.map((date) => date.startsAt);
}

/** What a wall clock in a zone actually is, as an instant. */
function at(iso: string) {
  return Date.parse(iso) / 1000;
}

describe("what it reads", () => {
  it("reads an ISO date and a 24-hour time", () => {
    // 1 October is BST: 19:00 local is 18:00 UTC.
    expect(starts(parse("2026-10-01 19:00"))).toEqual([at("2026-10-01T18:00:00Z")]);
  });

  it("reads the shapes people actually type in a Discord box", () => {
    for (const line of ["1 Oct 2026 7pm", "Oct 1 2026 7pm", "Thu 1 Oct 2026 7pm"]) {
      expect(starts(parse(line))).toEqual([at("2026-10-01T18:00:00Z")]);
    }
  });

  it("reads minutes after a dot or a colon", () => {
    expect(starts(parse("2026-10-01 19.30"))).toEqual([at("2026-10-01T18:30:00Z")]);
    expect(starts(parse("2026-10-01 7:30pm"))).toEqual([at("2026-10-01T18:30:00Z")]);
  });

  it("carries the duration from whatever the poll is about", () => {
    const result = parse("2026-10-01 19:00");
    if (!result.ok) throw new Error("expected a clean parse");
    expect(result.dates[0]!.endsAt - result.dates[0]!.startsAt).toBe(FOUR_HOURS);
  });

  it("skips blank lines rather than failing on them", () => {
    const result = parse("2026-10-01 19:00\n\n   \n2026-10-08 19:00");
    expect(starts(result)).toHaveLength(2);
  });

  it("quotes the line each date came from", () => {
    const result = parse("Thu 1 Oct 2026 7pm");
    if (!result.ok) throw new Error("expected a clean parse");
    expect(result.dates[0]!.source).toBe("Thu 1 Oct 2026 7pm");
  });
});

describe("the zone", () => {
  it("puts a date on the far side of a DST change at the time asked for", () => {
    // Britain leaves BST on 25 October 2026. Both of these are 19:00 local; they
    // are an hour apart in UTC, and a parser adding 604800 to the first would
    // put the second at 20:00 local.
    expect(starts(parse("2026-10-22 19:00"))).toEqual([at("2026-10-22T18:00:00Z")]);
    expect(starts(parse("2026-10-29 19:00"))).toEqual([at("2026-10-29T19:00:00Z")]);
  });

  it("reads the same text differently in a different zone", () => {
    expect(starts(parse("2026-10-01 19:00", { timeZone: "America/New_York" }))).toEqual([
      at("2026-10-01T23:00:00Z"),
    ]);
  });

  it("takes a year-less date as the next one to come round", () => {
    // Typing "1 Oct" in November means next year. Putting the poll eleven months
    // in the past would be worse than being wrong out loud.
    expect(starts(parse("1 Oct 7pm", { now: new Date("2026-11-05T12:00:00Z") }))).toEqual([
      at("2027-10-01T18:00:00Z"),
    ]);
    expect(starts(parse("1 Oct 7pm", { now: new Date("2026-09-14T12:00:00Z") }))).toEqual([
      at("2026-10-01T18:00:00Z"),
    ]);
  });

  it("reads the year-less rollover in the guild's zone, not the server's", () => {
    // 31 December 23:30 UTC is already 1 January 2027 in Auckland, so "2 Jan" is
    // tomorrow — 2027, not 2026. Reading the rollover in UTC would have put it
    // eleven months later still.
    const nye = new Date("2026-12-31T23:30:00Z");
    expect(starts(parse("2 Jan 7pm", { now: nye, timeZone: "Pacific/Auckland" }))).toEqual([
      at("2027-01-02T06:00:00Z"),
    ]);
  });
});

describe("what it refuses", () => {
  it("hands back a line it could not read, verbatim", () => {
    const result = parse("2026-10-01 19:00\nsometime next week\n2026-10-08 19:00");

    // Answering "3 of your 4 were fine" while silently dropping the fourth is
    // how a poll ends up missing the date everybody wanted.
    expect(result).toMatchObject({ ok: false, unreadable: ["sometime next week"] });
  });

  it("refuses all of them rather than costing somebody the nine good ones", () => {
    const result = parse("2026-10-01 19:00\nnonsense");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.unreadable).toEqual(["nonsense"]);
  });

  it("names every line it could not read, not just the first", () => {
    const result = parse("nonsense\n2026-10-01 19:00\nalso nonsense");
    if (result.ok) throw new Error("expected a refusal");
    expect(result.unreadable).toEqual(["nonsense", "also nonsense"]);
  });

  it("refuses an eleventh date and says how many there were", () => {
    const lines = Array.from({ length: MAX_DATES + 1 }, (_, i) => `2026-10-0${(i % 9) + 1} 19:00`);
    expect(parse(lines.join("\n"))).toMatchObject({ ok: false, tooMany: MAX_DATES + 1 });
  });

  it("refuses a bare number, because guessing is how a poll lands twelve hours out", () => {
    expect(parse("1 Oct 2026 7").ok).toBe(false);
  });

  it("refuses an impossible time", () => {
    expect(parse("2026-10-01 25:00").ok).toBe(false);
    expect(parse("2026-10-01 19:75").ok).toBe(false);
    expect(parse("2026-10-01 13pm").ok).toBe(false);
  });

  it("refuses a month it does not know", () => {
    expect(parse("1 Smarch 2026 7pm").ok).toBe(false);
  });
});

describe("what it is not", () => {
  it("parses a date in the past, because refusing one is a policy decision", () => {
    // Whether a poll may propose yesterday is the caller's question, not the
    // parser's.
    expect(starts(parse("2020-01-01 19:00"))).toEqual([at("2020-01-01T19:00:00Z")]);
  });

  it("is pure — same text, same zone, same now, same answer", () => {
    const text = "2026-10-01 19:00\n2026-10-08 19:00";
    expect(parse(text)).toEqual(parse(text));
  });
});
