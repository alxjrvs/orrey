import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { db, schema } from "../src/db/index.ts";
import { computeDayStats, loadDayStats, type DayRow } from "../src/stats/game-day.ts";
import { transition } from "../src/game-days/lifecycle.ts";
import { claimSeat } from "../src/game-days/signups.ts";

/**
 * How a day went.
 *
 * The whole of this file is one distinction: the two kinds of day answer
 * differently, and null, zero and one are three different answers. A multi day
 * with a fill rate of zero reads as "nobody came" about an evening that was
 * never going to have a capacity, and that is the sentence this file exists to
 * stop Orrey saying.
 */
const START = Math.floor(Date.parse("2026-11-07T18:00:00Z") / 1000);

function day(over: Partial<DayRow> = {}): DayRow {
  return {
    gameDayId: "day-1",
    kind: "single",
    state: "LOCKED",
    title: null,
    startsAt: START,
    capacity: 4,
    waitlistAtLock: 0,
    ...over,
  };
}

function seats(inCount: number, waiting = 0, out = 0) {
  return [
    ...Array.from({ length: inCount }, () => ({ gameDayId: "day-1", state: "in" as const })),
    ...Array.from({ length: waiting }, () => ({
      gameDayId: "day-1",
      state: "waitlisted" as const,
    })),
    ...Array.from({ length: out }, () => ({ gameDayId: "day-1", state: "out" as const })),
  ];
}

describe("fill rate", () => {
  it("is seated over the day's capacity", () => {
    expect(computeDayStats({ day: day(), seats: seats(3), tables: [] })?.fillRate).toBe(0.75);
  });

  it("is null on a multi day, which has no capacity to be full of", () => {
    const stats = computeDayStats({
      day: day({ kind: "multi", capacity: null }),
      seats: seats(9),
      tables: [],
    });

    // Not zero, which reads as "nobody came", and not one, which reads as
    // "full". A day that is open to however many turn up has no fill rate.
    expect(stats?.fillRate).toBeNull();
    expect(stats?.seated).toBe(9);
  });

  it("is zero on a single day nobody signed up for, which is a real answer", () => {
    expect(computeDayStats({ day: day(), seats: [], tables: [] })?.fillRate).toBe(0);
  });

  it("counts only the seated, not the queue or the withdrawn", () => {
    expect(computeDayStats({ day: day(), seats: seats(2, 3, 1), tables: [] })?.fillRate).toBe(0.5);
  });

  it("never divides by a capacity of zero", () => {
    const stats = computeDayStats({ day: day({ capacity: 0 }), seats: [], tables: [] });

    expect(stats?.fillRate).toBeNull();
    expect(Number.isNaN(stats?.fillRate as number)).toBe(false);
  });
});

describe("waitlist depth", () => {
  it("is what was recorded when the table settled", () => {
    expect(
      computeDayStats({ day: day({ waitlistAtLock: 4 }), seats: seats(4), tables: [] })
        ?.waitlistDepth,
    ).toBe(4);
  });

  it("is null on a day that has not locked, which is not the same as nobody queued", () => {
    expect(
      computeDayStats({
        day: day({ state: "SEATING", waitlistAtLock: null }),
        seats: seats(4, 2),
        tables: [],
      })?.waitlistDepth,
    ).toBeNull();
  });
});

describe("tables played", () => {
  it("counts the people who recorded one, on a multi day", () => {
    const stats = computeDayStats({
      day: day({ kind: "multi", capacity: null }),
      seats: seats(3),
      tables: [
        { gameDayId: "day-1", tablesPlayed: "Blades" },
        { gameDayId: "day-1", tablesPlayed: null },
        { gameDayId: "day-1", tablesPlayed: "" },
      ],
    });

    expect(stats?.tablesRecorded).toBe(1);
  });

  it("is none rather than zero on a day nobody recorded one for", () => {
    const stats = computeDayStats({
      day: day({ kind: "multi", capacity: null }),
      seats: seats(3),
      tables: [{ gameDayId: "day-1", tablesPlayed: null }],
    });

    expect(stats?.tablesRecorded).toBe(0);
  });

  it("is null on a single day, where the whole evening is one game", () => {
    expect(
      computeDayStats({ day: day(), seats: seats(4), tables: [] })?.tablesRecorded,
    ).toBeNull();
  });
});

describe("a day that was called off", () => {
  it("reports nothing at all", () => {
    // Its signups are a list of people who would have come. Averaging that into
    // a fill rate puts a day nobody played into the denominator of how full
    // days get.
    expect(computeDayStats({ day: day({ state: "CANCELLED" }), seats: seats(1), tables: [] }))
      .toBeNull();
  });
});

describe("loading it", () => {
  beforeEach(async () => {
    for (const table of [
      "audit_log",
      "attendance",
      "signups",
      "jobs",
      "sessions",
      "game_days",
      "games",
      "users",
      "settings",
    ]) {
      await env.DB.prepare(`DELETE FROM ${table}`).run();
    }
    await db(env)
      .insert(schema.games)
      .values({ id: "blades", name: "Blades in the Dark", maxPlayers: 2 });
    await db(env)
      .insert(schema.gameDays)
      .values({
        id: "day-1",
        kind: "single",
        gameId: "blades",
        state: "PROPOSED",
        startsAt: START,
        endsAt: START + 4 * 3600,
        capacity: 2,
        discordChannelId: "chan-1",
      });
    for (const id of ["a", "b", "c", "organiser"]) {
      await db(env)
        .insert(schema.users)
        .values({ discordId: id, username: id, feedToken: `t-${id}` });
    }
  });

  it("records the queue at the moment the table settles", async () => {
    await transition(env, "day-1", "SEATING", "organiser");
    for (const id of ["a", "b", "c"]) await claimSeat(env, "day-1", id);

    await transition(env, "day-1", "LOCKED", null);

    // Two seats, three claims: one queued. The number is written by the lock
    // rather than read back afterwards, because `withdraw` has no day-state
    // guard — a click on the locked day's post would otherwise shorten a queue
    // that had already stood.
    expect(await loadDayStats(env, "day-1")).toMatchObject({
      seated: 2,
      capacity: 2,
      fillRate: 1,
      waitlistDepth: 1,
    });
  });

  it("leaves the number alone once the day has played", async () => {
    await transition(env, "day-1", "SEATING", "organiser");
    for (const id of ["a", "b", "c"]) await claimSeat(env, "day-1", id);
    await transition(env, "day-1", "LOCKED", null);

    await transition(env, "day-1", "PLAYED", null);

    expect((await loadDayStats(env, "day-1"))?.waitlistDepth).toBe(1);
  });

  it("says not yet for a day still taking seats", async () => {
    await transition(env, "day-1", "SEATING", "organiser");
    for (const id of ["a", "b", "c"]) await claimSeat(env, "day-1", id);

    expect((await loadDayStats(env, "day-1"))?.waitlistDepth).toBeNull();
  });

  it("reports nothing for a day that was called off", async () => {
    await transition(env, "day-1", "SEATING", "organiser");
    await transition(env, "day-1", "CANCELLED", "organiser");

    expect(await loadDayStats(env, "day-1")).toBeNull();
  });
});
