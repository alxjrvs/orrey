import { env } from "cloudflare:test";
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { db, schema } from "../src/db/index.ts";
import {
  ENOUGH,
  attendanceRate,
  flakeFor,
  flakeForRoster,
  flakeLine,
  hasHistory,
} from "../src/campaigns/flake.ts";

/**
 * Flake memory: what somebody's attendance has actually looked like. Every test
 * here is really one of two questions — is the number honest, and does anything
 * happen because of it. The second answer is always no.
 */
const CAMPAIGN = "age-of-umbra";
const JOINED = Date.parse("2026-01-01T00:00:00Z") / 1000;
const WEEK = 7 * 86_400;

/** Session `n` of the campaign, played or not, `n` weeks after the roster date. */
async function session(n: number, state: "PLAYED" | "SCHEDULED" = "PLAYED") {
  const startsAt = JOINED + n * WEEK;
  await db(env).insert(schema.sessions).values({
    id: `${CAMPAIGN}-s${n}`,
    kind: "campaign_session",
    campaignId: CAMPAIGN,
    number: n,
    startsAt,
    endsAt: startsAt + 4 * 3600,
    location: "The Wreck",
    state,
  });
}

/** What `who` said about session `n`, and what happened. */
async function register(
  n: number,
  who: string,
  intent: "in" | "out" | "maybe" | null,
  attended: 0 | 1 | null,
  source: "auto" | "gm" = "auto",
) {
  await db(env)
    .insert(schema.attendance)
    .values({
      sessionId: `${CAMPAIGN}-s${n}`,
      userId: who,
      intent,
      attended,
      attendedSource: attended === null ? null : source,
    });
}

/** The primary key of one register row. */
function registerRow(n: number, who: string) {
  return and(
    eq(schema.attendance.sessionId, `${CAMPAIGN}-s${n}`),
    eq(schema.attendance.userId, who),
  );
}

async function member(who: string, role: "gm" | "player" = "player", joinedAt = JOINED) {
  await db(env)
    .insert(schema.users)
    .values({ discordId: who, username: who, feedToken: `t-${who}` })
    .onConflictDoNothing();
  await db(env)
    .insert(schema.campaignMembers)
    .values({ campaignId: CAMPAIGN, userId: who, role, joinedAt });
}

/** `n` played sessions they said in for and turned up to. */
async function attended(who: string, numbers: number[]) {
  for (const n of numbers) await register(n, who, "in", 1);
}

beforeEach(async () => {
  for (const table of [
    "attendance",
    "campaign_members",
    "jobs",
    "sessions",
    "campaigns",
    "users",
  ]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  await db(env)
    .insert(schema.campaigns)
    .values({ id: CAMPAIGN, name: "Age of Umbra", kind: "run", state: "RUNNING" });
});

describe("the count", () => {
  it("is over played sessions, not scheduled ones", async () => {
    await member("ana");
    for (const n of [1, 2, 3, 4]) await session(n);
    await session(5, "SCHEDULED");
    await attended("ana", [1, 2, 3, 4]);
    await register(5, "ana", "in", null);

    // A session that has not happened is not one she failed to come to.
    expect(await flakeFor(env, CAMPAIGN, "ana")).toMatchObject({
      played: 4,
      attended: 4,
    });
  });

  it("counts a session nobody wrote a register row for as missed", async () => {
    await member("ana");
    for (const n of [1, 2, 3, 4]) await session(n);
    await attended("ana", [1, 2]);

    // No row means nothing is known, and the honest denominator is still the
    // number of sessions that were played.
    expect(await flakeFor(env, CAMPAIGN, "ana")).toMatchObject({
      played: 4,
      attended: 2,
    });
  });

  it("starts when they joined, not when the campaign did", async () => {
    for (const n of [1, 2, 3, 4, 5, 6]) await session(n);
    await member("newcomer", "player", JOINED + 5 * WEEK);
    await attended("newcomer", [5, 6]);

    // Joining at session five and being told "came to 2 of 6" is a number about
    // somebody else's sessions.
    expect(await flakeFor(env, CAMPAIGN, "newcomer")).toMatchObject({
      played: 2,
      attended: 2,
    });
  });

  it("is what the GM corrected it to", async () => {
    await member("ana");
    for (const n of [1, 2, 3, 4]) await session(n);
    await attended("ana", [1, 2, 3]);
    // Auto-assumed absent, then the GM said she was there.
    await register(4, "ana", "in", 0, "auto");
    await db(env)
      .update(schema.attendance)
      .set({ attended: 1, attendedSource: "gm" })
      .where(registerRow(4, "ana"));

    // The register is the source of truth and a correction is part of it. This
    // is why the number is a query and never a stored tally.
    expect(await flakeFor(env, CAMPAIGN, "ana")).toMatchObject({
      played: 4,
      attended: 4,
      noShowStreak: 0,
    });
  });

  it("says nothing at all about a campaign with no history", async () => {
    await member("ana");

    expect(await flakeFor(env, CAMPAIGN, "ana")).toMatchObject({
      played: 0,
      attended: 0,
      noShowStreak: 0,
    });
    expect(await hasHistory(env, CAMPAIGN)).toBe(false);
  });

  it("knows the campaign has history once something has been played", async () => {
    await session(1);
    expect(await hasHistory(env, CAMPAIGN)).toBe(true);
  });
});

describe("the streak", () => {
  it("counts only said-in-and-did-not-show", async () => {
    await member("bo");
    for (const n of [1, 2, 3, 4]) await session(n);
    await attended("bo", [1, 2]);
    await register(3, "bo", "in", 0);
    await register(4, "bo", "in", 0);

    expect((await flakeFor(env, CAMPAIGN, "bo")).noShowStreak).toBe(2);
  });

  it("does not count saying out", async () => {
    await member("bo");
    for (const n of [1, 2, 3, 4]) await session(n);
    await attended("bo", [1, 2]);
    await register(3, "bo", "out", 0);
    await register(4, "bo", "out", 0);

    // Saying out is the system working. It is not a flake and must never read
    // as one.
    expect((await flakeFor(env, CAMPAIGN, "bo")).noShowStreak).toBe(0);
  });

  it("is the current run only", async () => {
    await member("bo");
    for (const n of [1, 2, 3, 4, 5]) await session(n);
    await register(1, "bo", "in", 0);
    await register(2, "bo", "in", 0);
    await register(3, "bo", "in", 0);
    await register(4, "bo", "in", 1);
    await register(5, "bo", "in", 0);

    // Missed three, came, missed one. Saying three would be a claim about a
    // person who has since turned up.
    expect((await flakeFor(env, CAMPAIGN, "bo")).noShowStreak).toBe(1);
  });

  it("is ended by a session they said nothing about", async () => {
    await member("bo");
    for (const n of [1, 2, 3]) await session(n);
    await register(1, "bo", "in", 0);
    await register(3, "bo", "in", 0);

    // Session two has no row: they did not say they were coming, so it is not
    // part of a run of broken promises.
    expect((await flakeFor(env, CAMPAIGN, "bo")).noShowStreak).toBe(1);
  });
});

describe("saying it", () => {
  const flake = (played: number, attendedCount: number, noShowStreak = 0) => ({
    userId: "ana",
    played,
    attended: attendedCount,
    noShowStreak,
  });

  it("says nothing below enough sessions to mean anything", () => {
    expect(flakeLine(flake(ENOUGH - 1, 0, 3))).toBeUndefined();

    // "0 of 3" looks like a number and is not one. No answer is the honest
    // answer until there is history to answer from.
    expect(ENOUGH).toBeGreaterThan(1);
  });

  it("gives the proportion once there is", () => {
    expect(flakeLine(flake(ENOUGH, ENOUGH - 1))).toBe(`came to ${ENOUGH - 1} of ${ENOUGH}`);
  });

  it("mentions a run of two or more, and not a single miss", () => {
    expect(flakeLine(flake(6, 3, 1))).not.toContain("missed");
    expect(flakeLine(flake(6, 3, 3))).toContain("missed the last 3");
  });

  it("has no rate for somebody with no sessions", () => {
    expect(attendanceRate(flake(0, 0))).toBeNull();
    expect(attendanceRate(flake(4, 3))).toBe(0.75);
  });
});

describe("the roster", () => {
  it("answers for everybody on it, the GM included", async () => {
    await member("gm-1", "gm");
    await member("ana");
    await member("bo");
    for (const n of [1, 2, 3, 4]) await session(n);
    await attended("gm-1", [1, 2, 3, 4]);
    await attended("ana", [1, 2]);

    const flakes = await flakeForRoster(env, CAMPAIGN);

    expect(flakes).toHaveLength(3);
    expect(flakes.find((f) => f.userId === "gm-1")).toMatchObject({ attended: 4 });
    expect(flakes.find((f) => f.userId === "ana")).toMatchObject({ attended: 2 });
    expect(flakes.find((f) => f.userId === "bo")).toMatchObject({ attended: 0 });
  });

  it("does not touch a seat, a reminder, or anything else", async () => {
    await member("bo");
    for (const n of [1, 2, 3, 4, 5, 6]) await session(n);
    for (const n of [1, 2, 3, 4, 5, 6]) await register(n, "bo", "in", 0);

    expect((await flakeFor(env, CAMPAIGN, "bo")).noShowStreak).toBe(6);

    // Six in a row is the worst this can ever say, and it is still only a
    // sentence. No roster row moved, no job was armed, nothing was written.
    expect(await db(env).select().from(schema.campaignMembers).all()).toHaveLength(1);
    expect(await db(env).select().from(schema.jobs).all()).toEqual([]);
  });
});
