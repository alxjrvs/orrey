import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { db, schema } from "../src/db/index.ts";

/**
 * The domain tables. What is worth a test here is not that drizzle can write a
 * row, but the rules the schema itself enforces — the parent a session's kind
 * promises, one Google event per session, and the two numbers a campaign is not
 * allowed to hold.
 */
const campaign = {
  id: "age-of-umbra",
  name: "Age of Umbra",
  kind: "run",
  discordChannelId: "100",
  discordRoleId: "200",
  state: "RUNNING",
} as const;

const session = {
  id: "age-of-umbra-s12",
  kind: "campaign_session",
  campaignId: campaign.id,
  number: 12,
  startsAt: 1_790_000_000,
  endsAt: 1_790_014_400,
  location: "The Wreck",
} as const;

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM sessions").run();
  await env.DB.prepare("DELETE FROM campaigns").run();
  await env.DB.prepare("DELETE FROM games").run();
  await env.DB.prepare("DELETE FROM users").run();
});

describe("the phase-1 tables", () => {
  it("stores one session of one running campaign", async () => {
    const d = db(env);
    await d.insert(schema.campaigns).values(campaign);
    await d.insert(schema.sessions).values(session);

    const row = await d.select().from(schema.sessions).get();
    expect(row).toMatchObject({ campaignId: "age-of-umbra", number: 12, state: "SCHEDULED" });
    // Nothing has been projected yet: both ids are the projector's to fill in.
    expect(row?.discordEventId).toBeNull();
    expect(row?.discordMessageId).toBeNull();
  });

  it("refuses a campaign session with no campaign", async () => {
    await expect(
      db(env).insert(schema.sessions).values({ ...session, campaignId: null }),
    ).rejects.toThrow();
  });

  it("refuses a one-off that hangs off a campaign", async () => {
    await db(env).insert(schema.campaigns).values(campaign);
    await expect(
      db(env).insert(schema.sessions).values({ ...session, kind: "one_off" }),
    ).rejects.toThrow();
  });

  it("accepts a one-off with no parent — game days give it one in phase 5", async () => {
    await db(env)
      .insert(schema.sessions)
      .values({ ...session, kind: "one_off", campaignId: null, number: null });

    expect(await db(env).select().from(schema.sessions).get()).toMatchObject({ kind: "one_off" });
  });

  it("allows one Google event per session and no more", async () => {
    const d = db(env);
    await d.insert(schema.campaigns).values(campaign);
    await d.insert(schema.sessions).values(session);
    await d.insert(schema.sessions).values({ ...session, id: "age-of-umbra-s13" });

    await d
      .insert(schema.calendarLinks)
      .values({ sessionId: session.id, gcalEventId: "aabbccdd" });

    await expect(
      d.insert(schema.calendarLinks).values({ sessionId: "age-of-umbra-s13", gcalEventId: "aabbccdd" }),
    ).rejects.toThrow();
  });

  it("keeps one attendance row per person per session", async () => {
    const d = db(env);
    await d.insert(schema.campaigns).values(campaign);
    await d.insert(schema.sessions).values(session);
    await d
      .insert(schema.users)
      .values({ discordId: "1001", username: "ada", feedToken: "tok" });

    const row = { sessionId: session.id, userId: "1001" };
    await d.insert(schema.attendance).values({ ...row, intent: "maybe" });
    await d
      .insert(schema.attendance)
      .values({ ...row, intent: "in" })
      .onConflictDoUpdate({
        target: [schema.attendance.sessionId, schema.attendance.userId],
        set: { intent: "in" },
      });

    const rows = await d.select().from(schema.attendance).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ intent: "in", attended: null, note: null });
  });
});

/**
 * Phase 2 widens the domain from one campaign to many: the game each plays, and
 * the cadence each keeps. Two of these are the schema refusing a number that
 * would break the materialiser before it ever runs.
 */
describe("games and cadence", () => {
  const game = {
    id: "mork-borg",
    name: "Mörk Borg",
    minPlayers: 3,
    maxPlayers: 5,
    defaultDurationMinutes: 240,
  };

  it("starts numbering at 1, and says nothing about a cadence it was not given", async () => {
    await db(env).insert(schema.campaigns).values(campaign);

    expect(await db(env).select().from(schema.campaigns).get()).toMatchObject({
      firstSessionNumber: 1,
      recurrenceAnchor: null,
      intervalWeeks: null,
      quorum: null,
      gameId: null,
    });
  });

  it("does not police the interval in the database, on purpose", async () => {
    // An interval of zero is a materialiser that never advances, and a CHECK
    // would be the natural place to refuse it. It is not there because adding a
    // constraint to `campaigns` means rebuilding the table, and in D1 dropping a
    // referenced table cascades its children away — every session, every
    // attendance row — while reporting success (docs/GOTCHAS.md).
    //
    // So this passes, and the rule lives in the code that writes the column.
    // If a future migration makes this throw, something rebuilt `campaigns`.
    await db(env).insert(schema.campaigns).values({ ...campaign, intervalWeeks: 0 });
    expect(await db(env).select().from(schema.campaigns).get()).toMatchObject({
      intervalWeeks: 0,
    });
  });

  it("keeps a CHECK on games, which nothing references yet", async () => {
    await expect(
      db(env).insert(schema.games).values({ id: "x", name: "X", minPlayers: 6, maxPlayers: 5 }),
    ).rejects.toThrow();
  });

  it("accepts a game with only one bound — plenty take whoever turns up", async () => {
    await db(env).insert(schema.games).values({ id: "open", name: "Open table", minPlayers: 2 });
    expect(await db(env).select().from(schema.games).get()).toMatchObject({ maxPlayers: null });
  });

  it("keeps the campaign when the game it plays is deleted", async () => {
    const d = db(env);
    await d.insert(schema.games).values(game);
    await d.insert(schema.campaigns).values({ ...campaign, gameId: game.id });
    await d.insert(schema.sessions).values(session);

    await d.delete(schema.games).where(eq(schema.games.id, game.id));

    // A campaign whose game row is removed is still a campaign, and the sessions
    // people are coming to must not go with it.
    expect(await d.select().from(schema.campaigns).get()).toMatchObject({ gameId: null });
    expect(await d.select().from(schema.sessions).all()).toHaveLength(1);
  });

  it("does not let an unresolvable quoted name pass for a value", async () => {
    // The trap that made migration 0005 need a hand (docs/GOTCHAS.md): SQLite
    // does not reject `SELECT "game_id" FROM campaigns` when campaigns has no
    // such column — it hands back the *string* `game_id`. A rebuild generated
    // with the new column list would have written that into every row, silently.
    // Pinned here so the next person who regenerates a rebuild finds out why.
    const row = await env.DB.prepare('SELECT "not_a_column" AS v').first<{ v: string }>();
    expect(row?.v).toBe("not_a_column");
  });
});
