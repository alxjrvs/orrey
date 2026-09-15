import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { db, schema } from "../src/db/index.ts";
import {
  computeCampaignAttendance,
  loadCampaignAttendance,
  type Mark,
  type Member,
  type PlayedSession,
} from "../src/stats/campaign.ts";

/**
 * What the attendance rows already say.
 *
 * Most of this is about the difference between three values a lazier version
 * would flatten into one: a recorded absence, a register nobody wrote, and a
 * session that never happened. Each means something different about a person,
 * and a stat that confuses them says something untrue about them.
 */
const START = Math.floor(Date.parse("2026-01-05T19:00:00Z") / 1000);
const WEEK = 7 * 86_400;

function session(n: number, state = "PLAYED"): PlayedSession {
  return { sessionId: `s${n}`, number: n, startsAt: START + n * WEEK, state };
}

function member(userId: string, joinedAtSession = 0): Member {
  return { userId, name: `Player ${userId}`, joinedAt: START + joinedAtSession * WEEK };
}

function mark(sessionId: string, userId: string, attended: boolean | null): Mark {
  return { sessionId, userId, attended };
}

describe("what counts as played", () => {
  it("is the state, not the calendar", () => {
    const stats = computeCampaignAttendance({
      sessions: [session(1), session(2, "SCHEDULED"), session(3, "CANCELLED")],
      members: [member("a")],
      marks: [mark("s1", "a", true), mark("s2", "a", true), mark("s3", "a", false)],
    });

    // A session in the past that nobody has corrected yet is not played, and a
    // cancelled one was never played at all — however long ago it was.
    expect(stats.sessionsPlayed).toBe(1);
    expect(stats.members[0]).toMatchObject({ played: 1, attended: 1 });
  });

  it("lets a cancellation break nobody's streak", () => {
    const stats = computeCampaignAttendance({
      sessions: [session(1), session(2, "CANCELLED"), session(3)],
      members: [member("a")],
      marks: [mark("s1", "a", true), mark("s2", "a", false), mark("s3", "a", true)],
    });

    // A session nobody could attend says nothing about anybody, so it is not a
    // gap in the run.
    expect(stats.members[0]?.streak).toBe(2);
  });
});

describe("the window a member is rated over", () => {
  it("starts when they joined", () => {
    const stats = computeCampaignAttendance({
      sessions: [session(1), session(2), session(3)],
      members: [member("late", 3)],
      marks: [
        mark("s1", "late", false),
        mark("s2", "late", false),
        mark("s3", "late", true),
      ],
    });

    // Sessions played before they were on the roster are not theirs to have
    // missed. Rating them on those is the bug this window exists to avoid.
    expect(stats.members[0]).toMatchObject({ played: 1, attended: 1, rate: 1 });
  });

  it("gives somebody with nothing behind them a null rate, not a zero", () => {
    const stats = computeCampaignAttendance({
      sessions: [session(1)],
      members: [member("brand-new", 5)],
      marks: [],
    });

    // `0.0` about a person reads as an accusation. "Nothing played yet" does
    // not, and the page can only say so if these are different values.
    expect(stats.members[0]).toMatchObject({ played: 0, attended: 0, rate: null, streak: 0 });
  });

  it("never divides by zero into NaN", () => {
    const stats = computeCampaignAttendance({
      sessions: [],
      members: [member("a")],
      marks: [],
    });

    expect(stats.members[0]?.rate).toBeNull();
    expect(Number.isNaN(stats.members[0]?.rate as number)).toBe(false);
  });
});

describe("a register nobody wrote", () => {
  it("is neither present nor absent", () => {
    const stats = computeCampaignAttendance({
      sessions: [session(1), session(2), session(3)],
      members: [member("a")],
      marks: [mark("s1", "a", true), mark("s2", "a", null), mark("s3", "a", true)],
    });

    // `attended` is tri-state in the schema. Counting `null` at either end of
    // the fraction is reading an unanswered session as a fact about somebody.
    expect(stats.members[0]).toMatchObject({ played: 2, attended: 2, rate: 1 });
  });

  it("neither continues a streak nor breaks one", () => {
    const stats = computeCampaignAttendance({
      sessions: [session(1), session(2), session(3)],
      members: [member("a")],
      marks: [mark("s1", "a", true), mark("s2", "a", null), mark("s3", "a", true)],
    });

    expect(stats.members[0]?.streak).toBe(2);
  });

  it("reads a missing row the same way as a null one", () => {
    const stats = computeCampaignAttendance({
      sessions: [session(1), session(2)],
      members: [member("a")],
      marks: [mark("s1", "a", true)],
    });

    expect(stats.members[0]).toMatchObject({ played: 1, attended: 1, streak: 1 });
  });
});

describe("the streak", () => {
  it("counts back from the most recent and stops at an absence", () => {
    const stats = computeCampaignAttendance({
      sessions: [session(1), session(2), session(3), session(4)],
      members: [member("a")],
      marks: [
        mark("s1", "a", true),
        mark("s2", "a", false),
        mark("s3", "a", true),
        mark("s4", "a", true),
      ],
    });

    expect(stats.members[0]?.streak).toBe(2);
  });

  it("is zero for somebody whose last session was a no-show", () => {
    const stats = computeCampaignAttendance({
      sessions: [session(1), session(2)],
      members: [member("a")],
      marks: [mark("s1", "a", true), mark("s2", "a", false)],
    });

    expect(stats.members[0]?.streak).toBe(0);
  });
});

describe("loading it", () => {
  beforeEach(async () => {
    for (const table of ["attendance", "campaign_members", "sessions", "campaigns", "users"]) {
      await env.DB.prepare(`DELETE FROM ${table}`).run();
    }
    await db(env)
      .insert(schema.campaigns)
      .values({ id: "umbra", name: "Age of Umbra", kind: "run", state: "RUNNING" });
  });

  it("reads the same answer the pure function gives", async () => {
    await db(env)
      .insert(schema.users)
      .values({ discordId: "a", username: "ada", globalName: "Ada", feedToken: "t-a" });
    await db(env)
      .insert(schema.campaignMembers)
      .values({ campaignId: "umbra", userId: "a", role: "player", joinedAt: START });
    for (const n of [1, 2, 3]) {
      await db(env)
        .insert(schema.sessions)
        .values({
          id: `s${n}`,
          kind: "campaign_session",
          campaignId: "umbra",
          number: n,
          startsAt: START + n * WEEK,
          endsAt: START + n * WEEK + 4 * 3600,
          state: n === 3 ? "SCHEDULED" : "PLAYED",
        });
    }
    await db(env)
      .insert(schema.attendance)
      .values([
        { sessionId: "s1", userId: "a", attended: 1 },
        { sessionId: "s2", userId: "a", attended: 0 },
      ]);

    const stats = await loadCampaignAttendance(env, "umbra");

    expect(stats.sessionsPlayed).toBe(2);
    expect(stats.members).toEqual([
      { userId: "a", name: "Ada", played: 2, attended: 1, rate: 0.5, streak: 0 },
    ]);
  });

  it("names somebody by their id when the cache has no name for them", async () => {
    await db(env).insert(schema.users).values({ discordId: "ghost", feedToken: "t-g" });
    await db(env)
      .insert(schema.campaignMembers)
      .values({ campaignId: "umbra", userId: "ghost", role: "player", joinedAt: START });

    expect((await loadCampaignAttendance(env, "umbra")).members[0]?.name).toBe("ghost");
  });

  it("answers for a campaign with nothing in it at all", async () => {
    expect(await loadCampaignAttendance(env, "umbra")).toEqual({
      sessionsPlayed: 0,
      members: [],
    });
  });
});
