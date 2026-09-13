import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { seedStatements, sessionIdFor, slugify } from "../src/db/seed-sql.ts";

/**
 * The seed is SQL an operator pipes into `wrangler d1 execute`, so the test
 * that matters is that the SQL runs — against the real migrated schema, twice,
 * the way a re-seed actually happens.
 */
const campaign = {
  name: "Age of Umbra",
  kind: "run",
  discordChannelId: "100",
  discordRoleId: "200",
  colour: 0x8b0000,
} as const;

const session = {
  number: 12,
  startsAt: Date.parse("2026-09-20T19:00:00Z") / 1000,
  endsAt: Date.parse("2026-09-20T23:00:00Z") / 1000,
  location: "The Wreck",
};

async function seed(over: Partial<typeof session> = {}): Promise<void> {
  for (const statement of seedStatements(campaign, { ...session, ...over })) {
    await env.DB.prepare(statement).run();
  }
}

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM jobs").run();
  await env.DB.prepare("DELETE FROM sessions").run();
  await env.DB.prepare("DELETE FROM campaigns").run();
});

describe("seeding the one hardcoded campaign", () => {
  it("writes the campaign and its session", async () => {
    await seed();

    const row = await env.DB.prepare("SELECT * FROM campaigns").first<Record<string, unknown>>();
    expect(row).toMatchObject({
      id: "age-of-umbra",
      name: "Age of Umbra",
      kind: "run",
      discord_channel_id: "100",
      discord_role_id: "200",
      location_type: "external",
      state: "RUNNING",
    });

    expect(await env.DB.prepare("SELECT * FROM sessions").first()).toMatchObject({
      id: "age-of-umbra-s12",
      kind: "campaign_session",
      campaign_id: "age-of-umbra",
      number: 12,
      location: "The Wreck",
      state: "SCHEDULED",
    });
  });

  it("re-seeds in place: the time moves, the projections do not", async () => {
    await seed();
    await env.DB.prepare(
      "UPDATE sessions SET discord_event_id = 'evt-1', discord_message_id = 'msg-1'",
    ).run();
    await env.DB.prepare("UPDATE campaigns SET state = 'HIATUS'").run();

    await seed({ startsAt: session.startsAt + 86_400, endsAt: session.endsAt + 86_400 });

    const rows = await env.DB.prepare("SELECT COUNT(*) AS n FROM sessions").first<{ n: number }>();
    expect(rows?.n).toBe(1);

    const after = await env.DB.prepare("SELECT * FROM sessions").first<Record<string, unknown>>();
    expect(after?.starts_at).toBe(session.startsAt + 86_400);
    // The projector owns these two. A re-seed that cleared them would orphan a
    // Discord event and a posted message.
    expect(after?.discord_event_id).toBe("evt-1");
    expect(after?.discord_message_id).toBe("msg-1");

    // And a paused campaign is not quietly resumed by re-running the seed.
    const campaignAfter = await env.DB.prepare("SELECT state FROM campaigns").first<{ state: string }>();
    expect(campaignAfter?.state).toBe("HIATUS");
  });

it("arms one standing job per surface, and re-arms rather than piling up", async () => {
    await seed();
    const jobs = await env.DB.prepare("SELECT id, kind, state FROM jobs ORDER BY id").all();
    expect(jobs.results).toEqual([
      {
        id: "session.post-attendance:age-of-umbra-s12",
        kind: "session.post-attendance",
        state: "pending",
      },
      { id: "session.project:age-of-umbra-s12", kind: "session.project", state: "pending" },
    ]);

    await env.DB.prepare("UPDATE jobs SET state = 'done', attempts = 3").run();
    await seed({ startsAt: session.startsAt + 3600 });

    const rows = await env.DB.prepare("SELECT COUNT(*) AS n FROM jobs").first<{ n: number }>();
    expect(rows?.n).toBe(2);
    expect(await env.DB.prepare("SELECT state, attempts FROM jobs").first()).toMatchObject({
      state: "pending",
      attempts: 0,
    });
  });

  it("survives a name with an apostrophe in it", async () => {
    for (const statement of seedStatements(
      { ...campaign, name: "Ada's Game", id: "adas-game" },
      session,
    )) {
      await env.DB.prepare(statement).run();
    }

    expect(await env.DB.prepare("SELECT name FROM campaigns").first<{ name: string }>()).toEqual({
      name: "Ada's Game",
    });
  });

  it("refuses a seed Discord would reject anyway", () => {
    expect(() => seedStatements(campaign, { ...session, endsAt: session.startsAt })).toThrow(/ends before/);
    // An EXTERNAL scheduled event has nowhere to point without a location.
    expect(() => seedStatements(campaign, { ...session, location: null })).toThrow(/location/);
    expect(() =>
      seedStatements({ ...campaign, locationType: "voice" }, session),
    ).toThrow(/voice channel/);
  });

  it("mints an id from the name, and a session id from the number or the date", () => {
    expect(slugify("Age of Umbra")).toBe("age-of-umbra");
    expect(sessionIdFor("age-of-umbra", session)).toBe("age-of-umbra-s12");
    expect(sessionIdFor("age-of-umbra", { ...session, number: null })).toBe("age-of-umbra-2026-09-20");
  });
});
