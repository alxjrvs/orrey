import { describe, expect, it } from "vitest";
import { ticksDueAt } from "../src/cron/scheduled.ts";

describe("the clock", () => {
  it("drains jobs every minute and nothing else off the hour", () => {
    expect(ticksDueAt(new Date("2026-09-13T10:17:00Z"))).toEqual(["drain"]);
  });

  it("materialises the horizon on the hour", () => {
    expect(ticksDueAt(new Date("2026-09-13T10:00:00Z"))).toEqual(["drain", "horizon"]);
  });

  it("renews Google watch channels at 04:00 UTC and reconciles at 05:30 UTC", () => {
    expect(ticksDueAt(new Date("2026-09-13T04:00:00Z"))).toEqual(["drain", "horizon", "watch-renew"]);
    expect(ticksDueAt(new Date("2026-09-13T05:30:00Z"))).toEqual(["drain", "reconcile"]);
    expect(ticksDueAt(new Date("2026-09-13T05:00:00Z"))).toEqual(["drain", "horizon"]);
  });
});
