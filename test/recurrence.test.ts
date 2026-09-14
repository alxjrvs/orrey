import { describe, expect, it } from "vitest";
import { occurrencesFrom, type Cadence } from "../src/campaigns/recurrence.ts";

/**
 * The anchor is usually in the past, and the step is taken in wall-clock time.
 * Both of those are the point, and both are what the tests are about — a
 * fortnightly 19:00 game must still be a 19:00 game in November.
 */
const LONDON = "Europe/London";
const NEW_YORK = "America/New_York";

const unix = (iso: string) => Math.floor(Date.parse(iso) / 1000);

function cadence(over: Partial<Cadence> = {}): Cadence {
  return {
    anchor: unix("2024-01-06T19:00:00Z"),
    intervalWeeks: 2,
    firstSessionNumber: 1,
    from: unix("2026-09-14T00:00:00Z"),
    count: 3,
    timezone: LONDON,
    durationMinutes: 240,
    ...over,
  };
}

/** What a clock in that zone reads at an instant. */
function localOf(unixSeconds: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(unixSeconds * 1000));
}

describe("occurrences from an anchor and an interval", () => {
  it("skips everything already past and keeps the numbering honest", () => {
    const from = unix("2026-09-14T00:00:00Z");
    const [first, second, third] = occurrencesFrom(cadence({ from }));

    expect(first!.startsAt).toBeGreaterThanOrEqual(from);
    // Every occurrence is a whole number of two-week steps from the anchor.
    for (const at of [first!, second!, third!]) {
      const weeks = (at.startsAt - unix("2024-01-06T19:00:00Z")) / (7 * 86_400);
      expect(Math.round(weeks) % 2).toBe(0);
    }
    // The number counts intervals since the anchor, not items returned.
    expect(second!.number).toBe(first!.number + 1);
    expect(third!.number).toBe(first!.number + 2);
    expect(first!.number).toBeGreaterThan(60);
  });

  it("numbers from first_session_number, so history can start anywhere", () => {
    const from = unix("2024-01-06T00:00:00Z");
    const [first] = occurrencesFrom(cadence({ from, firstSessionNumber: 47 }));

    // `from` is the anchor's own day, so this is the anchor occurrence itself.
    expect(first).toMatchObject({ number: 47, startsAt: unix("2024-01-06T19:00:00Z") });
  });

  it("keeps its wall-clock hour across the spring change", () => {
    // 19:00 New York in February; the clocks go forward on 9 March 2025.
    const anchor = unix("2025-02-22T00:00:00Z"); // 19:00 on the 21st, EST
    const occurrences = occurrencesFrom(
      cadence({
        anchor,
        timezone: NEW_YORK,
        from: anchor,
        count: 4,
        intervalWeeks: 2,
      }),
    );

    for (const at of occurrences) {
      expect(localOf(at.startsAt, NEW_YORK)).toMatch(/19:00$/);
    }
    // And it really did cross the change: the UTC hour moved, the local one did not.
    const hours = occurrences.map((at) => new Date(at.startsAt * 1000).getUTCHours());
    expect(new Set(hours).size).toBe(2);
  });

  it("keeps its wall-clock hour across the autumn change", () => {
    const anchor = unix("2025-10-15T18:00:00Z"); // 19:00 in London, BST
    const occurrences = occurrencesFrom(
      cadence({ anchor, timezone: LONDON, from: anchor, count: 4, intervalWeeks: 2 }),
    );

    for (const at of occurrences) {
      expect(localOf(at.startsAt, LONDON)).toMatch(/19:00$/);
    }
  });

  it("returns exactly as many as asked for, and none for none", () => {
    expect(occurrencesFrom(cadence({ count: 7 }))).toHaveLength(7);
    expect(occurrencesFrom(cadence({ count: 0 }))).toEqual([]);
  });

  it("gives every occurrence the campaign's usual length", () => {
    const [first] = occurrencesFrom(cadence({ durationMinutes: 180 }));
    expect(first!.endsAt - first!.startsAt).toBe(180 * 60);
  });

  it("starts at the anchor when the anchor is still ahead", () => {
    const anchor = unix("2030-01-01T19:00:00Z");
    const [first] = occurrencesFrom(cadence({ anchor, from: unix("2026-09-14T00:00:00Z") }));

    // Nothing before the anchor exists, so the count never goes negative.
    expect(first).toMatchObject({ number: 1, startsAt: anchor });
  });

  it("refuses an interval that would never advance", () => {
    for (const intervalWeeks of [0, -1]) {
      expect(() => occurrencesFrom(cadence({ intervalWeeks }))).toThrow(/must be positive/);
    }
  });

  it("handles a weekly cadence as readily as a fortnightly one", () => {
    const anchor = unix("2026-01-05T19:00:00Z");
    const occurrences = occurrencesFrom(
      cadence({ anchor, intervalWeeks: 1, from: anchor, count: 3 }),
    );

    expect(occurrences.map((at) => at.startsAt - anchor)).toEqual([
      0,
      7 * 86_400,
      14 * 86_400,
    ]);
  });
});
