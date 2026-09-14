import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { db, schema } from "../src/db/index.ts";
import { SESSION_CONFIRMED, SESSION_MOVED } from "../src/db/audit.ts";
import { computeScheduleStats, loadScheduleStats } from "../src/stats/schedule.ts";

/**
 * The scheduling half of #47, read out of the audit trail.
 *
 * The question here is not "what do the rows say" but "do these two kinds mean
 * what the statistic claims". So most of this is about the difference between a
 * session that was excluded and one that scored zero — which the page has to be
 * able to tell apart, because they read very differently.
 */
const MADE = Math.floor(Date.parse("2026-01-01T12:00:00Z") / 1000);
const HOUR = 3600;

function session(n: number, createdAt = MADE) {
  return { sessionId: `s${n}`, number: n, createdAt };
}

describe("most rescheduled", () => {
  it("is the session that moved most", () => {
    const stats = computeScheduleStats({
      sessions: [session(1), session(2)],
      moves: [
        { sessionId: "s1" },
        { sessionId: "s1" },
        { sessionId: "s1" },
        { sessionId: "s2" },
        { sessionId: "s2" },
      ],
      confirms: [],
    });

    expect(stats.mostRescheduled).toEqual({ sessionId: "s1", number: 1, moves: 3 });
  });

  it("is null when nothing has ever moved", () => {
    const stats = computeScheduleStats({ sessions: [session(1)], moves: [], confirms: [] });

    // Null is "no answer yet". A session that moved zero times is not the
    // most-rescheduled session, and naming one would be a number out of nothing.
    expect(stats.mostRescheduled).toBeNull();
  });

  it("ignores a move of a session this campaign does not own", () => {
    const stats = computeScheduleStats({
      sessions: [session(1)],
      moves: [{ sessionId: "somebody-elses" }],
      confirms: [],
    });

    expect(stats.mostRescheduled).toBeNull();
  });
});

describe("lead time to quorum", () => {
  it("is the gap between the session being made and confirming itself", () => {
    const stats = computeScheduleStats({
      sessions: [session(1)],
      moves: [],
      confirms: [{ sessionId: "s1", createdAt: MADE + 48 * HOUR }],
    });

    expect(stats.averageLeadSeconds).toBe(48 * HOUR);
    expect(stats.confirmed).toBe(1);
  });

  it("leaves out a session that never confirmed rather than counting it as zero", () => {
    const stats = computeScheduleStats({
      sessions: [session(1), session(2)],
      moves: [],
      confirms: [{ sessionId: "s1", createdAt: MADE + 10 * HOUR }],
    });

    // A session nobody confirmed has no lead time — not a lead time of nothing.
    // Counting it as zero would halve the average and say something untrue
    // about how quickly this campaign fills up.
    expect(stats.averageLeadSeconds).toBe(10 * HOUR);
    expect(stats.confirmed).toBe(1);
  });

  it("is null, not zero, when none has confirmed", () => {
    const stats = computeScheduleStats({
      sessions: [session(1), session(2)],
      moves: [],
      confirms: [],
    });

    expect(stats.averageLeadSeconds).toBeNull();
    expect(stats.confirmed).toBe(0);
  });

  it("counts the first confirmation when there are two", () => {
    const stats = computeScheduleStats({
      sessions: [session(1)],
      moves: [],
      confirms: [
        { sessionId: "s1", createdAt: MADE + 30 * HOUR },
        { sessionId: "s1", createdAt: MADE + 2 * HOUR },
      ],
    });

    expect(stats.averageLeadSeconds).toBe(2 * HOUR);
  });

  it("never drags the mean below zero on a clock nobody can read", () => {
    const stats = computeScheduleStats({
      sessions: [session(1, MADE)],
      moves: [],
      confirms: [{ sessionId: "s1", createdAt: MADE - HOUR }],
    });

    expect(stats.averageLeadSeconds).toBe(0);
  });
});

describe("a campaign with nothing recorded", () => {
  it("returns nulls in every field and throws nowhere", () => {
    expect(computeScheduleStats({ sessions: [], moves: [], confirms: [] })).toEqual({
      mostRescheduled: null,
      averageLeadSeconds: null,
      confirmed: 0,
    });
  });
});

describe("loading it", () => {
  beforeEach(async () => {
    for (const table of ["audit_log", "sessions", "campaigns", "users"]) {
      await env.DB.prepare(`DELETE FROM ${table}`).run();
    }
    await db(env)
      .insert(schema.campaigns)
      .values({ id: "umbra", name: "Age of Umbra", kind: "run", state: "RUNNING" });
  });

  async function audit(action: string, targetId: string, createdAt: number) {
    await db(env)
      .insert(schema.auditLog)
      .values({
        id: crypto.randomUUID(),
        actorUserId: null,
        action,
        targetType: "session",
        targetId,
        createdAt,
      });
  }

  it("reads the two kinds by the names the writers use", async () => {
    for (const n of [1, 2]) {
      await db(env)
        .insert(schema.sessions)
        .values({
          id: `s${n}`,
          kind: "campaign_session",
          campaignId: "umbra",
          number: n,
          startsAt: MADE + n * 86_400,
          endsAt: MADE + n * 86_400 + 4 * HOUR,
          createdAt: MADE,
        });
    }
    await audit(SESSION_MOVED, "s2", MADE + HOUR);
    await audit(SESSION_MOVED, "s2", MADE + 2 * HOUR);
    await audit(SESSION_CONFIRMED, "s1", MADE + 6 * HOUR);
    // A kind this statistic does not read, to prove it is matching rather than
    // counting every row against the session.
    await audit("campaign.update", "s1", MADE + 7 * HOUR);

    const stats = await loadScheduleStats(env, "umbra");

    expect(stats.mostRescheduled).toEqual({ sessionId: "s2", number: 2, moves: 2 });
    expect(stats.averageLeadSeconds).toBe(6 * HOUR);
    expect(stats.confirmed).toBe(1);
  });

  it("answers for a campaign with no sessions at all", async () => {
    expect(await loadScheduleStats(env, "umbra")).toEqual({
      mostRescheduled: null,
      averageLeadSeconds: null,
      confirmed: 0,
    });
  });
});
