import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { db, schema } from "../src/db/index.ts";
import { SETTING_KEYS, setSetting } from "../src/db/settings.ts";
import { dayIn, monthGrid, monthWindow } from "../src/console/month.ts";

/**
 * The month grid.
 *
 * Three things can be wrong with a calendar and all three are silent: it can ask
 * for the wrong window, it can put a session in the wrong cell, and it can
 * change height when you step between months. These test each.
 */
const ASOF = new Date("2026-11-01T12:00:00Z");

async function session(id: string, iso: string) {
  const startsAt = Math.floor(Date.parse(iso) / 1000);
  await db(env)
    .insert(schema.sessions)
    .values({
      id,
      kind: "campaign_session",
      campaignId: "umbra",
      number: 1,
      startsAt,
      endsAt: startsAt + 3600,
    });
  return id;
}

beforeEach(async () => {
  for (const table of ["attendance", "campaign_members", "sessions", "campaigns", "users", "settings"]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  await setSetting(env, SETTING_KEYS.guildId, "g1");
  await db(env)
    .insert(schema.campaigns)
    .values({ id: "umbra", name: "Age of Umbra", kind: "run", state: "RUNNING" });
});

describe("the window", () => {
  it("reaches into the months either side, because the grid shows them", async () => {
    // March 2026 begins on a Sunday, so the grid's first row is almost all
    // February. A window over the month proper would render those cells empty
    // and be quietly wrong about the last week of March too.
    const { days } = monthWindow(2026, 3, "Europe/London");

    expect(days).toHaveLength(42);
    expect(days[0]).toBe("2026-02-23");
    expect(days[41]).toBe("2026-04-05");
  });

  it("starts every row on a Monday", async () => {
    for (const month of [1, 2, 3, 6, 9, 12]) {
      const { days } = monthWindow(2026, month, "Europe/London");
      for (let row = 0; row < 6; row++) {
        const first = new Date(`${days[row * 7]}T00:00:00Z`);
        expect(first.getUTCDay()).toBe(1);
      }
    }
  });

  it("ends after the last cell, not at its midnight", async () => {
    const { to } = monthWindow(2026, 3, "Europe/London");

    // Half-open. A session at 23:30 on the final Sunday belongs in that cell,
    // and a bound at its own midnight would drop it.
    expect(to).toBe(Math.floor(Date.parse("2026-04-05T23:00:00Z") / 1000));
  });
});

describe("which cell a session lands in", () => {
  it("is the guild's day, not the server's", async () => {
    await session("late", "2026-11-30T23:30:00Z");

    // 23:30 UTC on 30 November is already 1 December in Auckland and still the
    // 30th in New York. The table's zone is the one that decides, or two people
    // see the same session on two different days.
    expect(dayIn(Math.floor(Date.parse("2026-11-30T23:30:00Z") / 1000), "Europe/London")).toBe(
      "2026-11-30",
    );
    expect(dayIn(Math.floor(Date.parse("2026-11-30T23:30:00Z") / 1000), "Pacific/Auckland")).toBe(
      "2026-12-01",
    );
  });

  it("keeps a session at 23:30 on the last of the month inside that month", async () => {
    await setSetting(env, SETTING_KEYS.timezone, "Europe/London");
    await session("late", "2026-11-30T23:30:00Z");

    const month = await monthGrid(env, 2026, 11, ASOF);
    const cells = month.weeks.flat();

    const cell = cells.find((day) => day.day === "2026-11-30");
    expect(cell?.inMonth).toBe(true);
    expect(cell?.sessions.map((row) => row.sessionId)).toEqual(["late"]);
  });

  it("marks the leading and trailing cells as not this month", async () => {
    await setSetting(env, SETTING_KEYS.timezone, "Europe/London");
    await session("february", "2026-02-24T19:00:00Z");

    const month = await monthGrid(env, 2026, 3, ASOF);
    const cell = month.weeks.flat().find((day) => day.day === "2026-02-24");

    // Shown, because the grid draws it — but not dressed up as March.
    expect(cell?.inMonth).toBe(false);
    expect(cell?.sessions.map((row) => row.sessionId)).toEqual(["february"]);
  });

  it("steps calendar days across a DST change rather than 86,400 seconds", async () => {
    await setSetting(env, SETTING_KEYS.timezone, "Europe/London");
    // The clocks go forward in the UK on 29 March 2026. A week containing it is
    // 167 hours, and arithmetic that assumes 168 puts this in Saturday's cell.
    await session("after", "2026-03-29T18:00:00Z");

    const month = await monthGrid(env, 2026, 3, ASOF);
    const cell = month.weeks.flat().find((day) => day.day === "2026-03-29");

    expect(cell?.sessions.map((row) => row.sessionId)).toEqual(["after"]);
  });
});

describe("the shape of the grid", () => {
  it("is six rows for a month that would otherwise need five", async () => {
    await setSetting(env, SETTING_KEYS.timezone, "Europe/London");

    // November 2026 starts on a Sunday and has 30 days — five rows would hold
    // it. It gets six anyway, because a grid that changes height when somebody
    // steps between months is one people misclick.
    const month = await monthGrid(env, 2026, 11, ASOF);

    expect(month.weeks).toHaveLength(6);
    expect(month.weeks.every((week) => week.length === 7)).toBe(true);
  });

  it("is six rows for a month that needs six", async () => {
    await setSetting(env, SETTING_KEYS.timezone, "Europe/London");
    const month = await monthGrid(env, 2026, 8, ASOF);

    expect(month.weeks).toHaveLength(6);
    expect(month.weeks.flat()).toHaveLength(42);
  });

  it("says which zone it was drawn in", async () => {
    await setSetting(env, SETTING_KEYS.timezone, "Pacific/Auckland");
    expect((await monthGrid(env, 2026, 11, ASOF)).timeZone).toBe("Pacific/Auckland");
  });
});
