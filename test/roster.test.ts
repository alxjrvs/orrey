import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { db, schema } from "../src/db/index.ts";
import { isExhausted, remainingSessions, rosterOf } from "../src/campaigns/roster.ts";
import { attendanceRows } from "../src/attendance/rows.ts";
import { seedStatements } from "../src/db/seed-sql.ts";

/**
 * Where a roster comes from, and when a campaign stops producing sessions.
 *
 * The first is #22's structural claim made testable: a campaign entered straight
 * into RUNNING never had signups and must not be asked for them.
 */
const CAMPAIGN = "age-of-umbra";
const SESSION_ID = "age-of-umbra-s12";

const campaign = {
  name: "Age of Umbra",
  kind: "run",
  discordChannelId: "chan-1",
  discordRoleId: "role-1",
} as const;

const session = {
  number: 12,
  startsAt: Date.parse("2026-09-20T19:00:00Z") / 1000,
  endsAt: Date.parse("2026-09-20T23:00:00Z") / 1000,
  location: "The Wreck",
};

async function seedUser(id: string, name: string) {
  await db(env)
    .insert(schema.users)
    .values({ discordId: id, username: name.toLowerCase(), globalName: name, feedToken: `t-${id}` })
    .onConflictDoNothing();
}

beforeEach(async () => {
  for (const table of [
    "attendance",
    "signups",
    "campaign_members",
    "audit_log",
    "publications",
    "jobs",
    "sessions",
    "campaigns",
    "users",
  ]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  for (const statement of seedStatements(campaign, session)) {
    await env.DB.prepare(statement).run();
  }
});

describe("where a roster comes from", () => {
  it("reads members for a campaign that has started", async () => {
    await seedUser("1", "Ada");
    await seedUser("2", "Bob");
    await db(env)
      .insert(schema.campaignMembers)
      .values([
        { campaignId: CAMPAIGN, userId: "1", role: "gm", joinedAt: 1_000 },
        { campaignId: CAMPAIGN, userId: "2", role: "player", characterName: "Hollow", joinedAt: 2_000 },
      ]);
    // A stale signup row from before it started. It must not be read.
    await seedUser("9", "Stale");
    await db(env)
      .insert(schema.signups)
      .values({ targetType: "campaign_forming", targetId: CAMPAIGN, userId: "9", state: "in" });

    expect(await rosterOf(env, CAMPAIGN)).toEqual([
      { userId: "1", name: "Ada", role: "gm", characterName: null },
      { userId: "2", name: "Bob", role: "player", characterName: "Hollow" },
    ]);
  });

  it("reads accepted signups for a campaign that has not", async () => {
    await env.DB.prepare("UPDATE campaigns SET state = 'FORMING'").run();
    await seedUser("1", "Ada");
    await seedUser("2", "Bob");
    await seedUser("3", "Cara");
    await db(env)
      .insert(schema.signups)
      .values([
        { targetType: "campaign_forming", targetId: CAMPAIGN, userId: "1", state: "in", createdAt: 1_000 },
        { targetType: "campaign_forming", targetId: CAMPAIGN, userId: "2", state: "waitlisted", createdAt: 2_000 },
        { targetType: "campaign_forming", targetId: CAMPAIGN, userId: "3", state: "out", createdAt: 3_000 },
      ]);

    // Nobody is GM of a campaign that has not started, and the waitlist is the
    // queue behind the roster rather than part of it.
    expect(await rosterOf(env, CAMPAIGN)).toEqual([
      { userId: "1", name: "Ada", role: null, characterName: null },
    ]);
  });

  it("falls back to a mention for somebody Orrey has never seen speak", async () => {
    await db(env)
      .insert(schema.users)
      .values({ discordId: "7", username: null, globalName: null, feedToken: "t-7" });
    await db(env)
      .insert(schema.campaignMembers)
      .values({ campaignId: CAMPAIGN, userId: "7" });

    expect(await rosterOf(env, CAMPAIGN)).toMatchObject([{ name: "<@7>" }]);
  });

  it("has no roster for a campaign that does not exist", async () => {
    expect(await rosterOf(env, "nope")).toEqual([]);
  });
});

describe("the post, now that there is a roster", () => {
  it("lists the people who have not answered, without calling them out", async () => {
    await seedUser("1", "Ada");
    await seedUser("2", "Bob");
    await db(env)
      .insert(schema.campaignMembers)
      .values([
        { campaignId: CAMPAIGN, userId: "1", joinedAt: 1_000 },
        { campaignId: CAMPAIGN, userId: "2", joinedAt: 2_000 },
      ]);
    await db(env)
      .insert(schema.attendance)
      .values({ sessionId: SESSION_ID, userId: "1", intent: "in" });

    expect(await attendanceRows(env, SESSION_ID)).toEqual([
      { userId: "1", name: "Ada", intent: "in", note: null },
      { userId: "2", name: "Bob", intent: null, note: null },
    ]);
  });

  it("keeps somebody who answered and then left the roster", async () => {
    await seedUser("1", "Ada");
    await db(env)
      .insert(schema.attendance)
      .values({ sessionId: SESSION_ID, userId: "1", intent: "out" });

    // They are not on the roster, but they did answer, and that answer is still
    // true of them. Dropping it would quietly change the tally.
    expect(await attendanceRows(env, SESSION_ID)).toMatchObject([{ userId: "1", intent: "out" }]);
  });

  it("has no silence to report for a one-off with no campaign", async () => {
    await db(env).insert(schema.sessions).values({
      id: "one-off-1",
      kind: "one_off",
      campaignId: null,
      startsAt: session.startsAt,
      endsAt: session.endsAt,
    });

    expect(await attendanceRows(env, "one-off-1")).toEqual([]);
  });
});

describe("when a campaign stops producing sessions", () => {
  it("counts down to the cap and stops there", () => {
    expect(remainingSessions({ maxSessions: 10 }, 7)).toBe(3);
    expect(remainingSessions({ maxSessions: 10 }, 10)).toBe(0);
    // Somebody entered more by hand than the cap allows. Still zero, not -2.
    expect(remainingSessions({ maxSessions: 10 }, 12)).toBe(0);
  });

  it("never exhausts a campaign with no cap", () => {
    expect(remainingSessions({ maxSessions: null }, 500)).toBeNull();
    expect(isExhausted({ maxSessions: null }, 500)).toBe(false);
  });

  it("is exhausted exactly at the cap", () => {
    expect(isExhausted({ maxSessions: 10 }, 9)).toBe(false);
    expect(isExhausted({ maxSessions: 10 }, 10)).toBe(true);
  });
});

describe("a shortened post still accounts for everybody", () => {
  it("counts a note-leaver among the unanswered once notes are dropped", async () => {
    const { renderAttendancePost } = await import("../src/attendance/render.ts");
    const { loadProjectionTarget } = await import("../src/projection/target.ts");
    const target = (await loadProjectionTarget(env, SESSION_ID))!;

    const rows = [
      { userId: "1", name: "Ada", intent: null, note: "running late" },
      { userId: "2", name: "Bob", intent: null, note: null },
    ] as const;

    const full = renderAttendancePost({ target, rows: [...rows], asOf: new Date() });
    // With notes shown, Ada is in the Notes line and only Bob is unheard from.
    expect(full.content).toContain("running late");
    expect(full.content).toContain("Not heard from (1)");

    // A post long enough to drop notes must not drop Ada with them: she is
    // unanswered either way, and a tally smaller than the roster is a lie.
    const long = Array.from({ length: 90 }, (_, i) => ({
      userId: `n${i}`,
      name: `Somebody With A Fairly Long Display Name ${i}`,
      intent: null,
      note: `a note that is long enough to matter ${i}`,
    }));
    const shortened = renderAttendancePost({
      target,
      rows: [...rows, ...long],
      asOf: new Date(),
    });

    expect(shortened.content).not.toContain("running late");
    expect(shortened.content).toContain(`Not heard from (${rows.length + long.length})`);
  });
});
