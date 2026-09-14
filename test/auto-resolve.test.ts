import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db, schema } from "../src/db/index.ts";
import { SETTING_KEYS, setSetting } from "../src/db/settings.ts";
import { mintId } from "../src/db/ids.ts";
import { createApp } from "../src/http/app.ts";
import { InteractionResponseType, InteractionType } from "../src/discord/types.ts";
import { encodeCustomId } from "../src/discord/custom-id.ts";
import { fakeDiscord } from "./discord.ts";

/**
 * Opt-in, and never past the GM. This asserts the *moment* a poll closes itself,
 * not the consequence — what a closed poll then causes is the use-lines'
 * business and is tested there.
 */
const realFetch = globalThis.fetch;
const discord = await fakeDiscord();
const app = createApp();
const POLL = "pollid123456";
const START = Date.parse("2026-10-01T19:00:00Z") / 1000;
const GM = "gm-1";

let dates: string[] = [];

async function person(id: string) {
  await db(env)
    .insert(schema.users)
    .values({ discordId: id, username: id, feedToken: `t-${id}` })
    .onConflictDoNothing();
}

async function seed({ optedIn }: { optedIn: boolean }, over: Partial<typeof schema.datePolls.$inferInsert> = {}) {
  await db(env)
    .insert(schema.games)
    .values({ id: "blades", name: "Blades in the Dark", minPlayers: 3, maxPlayers: 6 })
    .onConflictDoNothing();
  await db(env).insert(schema.campaigns).values({
    id: "umbra",
    name: "Age of Umbra",
    kind: "run",
    state: "RUNNING",
    discordChannelId: "chan-1",
    autoResolvePolls: optedIn ? 1 : 0,
  });
  for (const id of [GM, "ada", "bo"]) await person(id);
  await db(env)
    .insert(schema.campaignMembers)
    .values([
      { campaignId: "umbra", userId: GM, role: "gm" },
      { campaignId: "umbra", userId: "ada" },
      { campaignId: "umbra", userId: "bo" },
    ]);
  await db(env).insert(schema.datePolls).values({
    id: POLL,
    campaignId: "umbra",
    discordChannelId: "chan-1",
    openedBy: GM,
    winRule: "min_players",
    winThreshold: 2,
    // An untargeted poll names its game and its kind, because `openPoll`
    // refuses one that does not — `needs-game`, `needs-kind`. A fixture
    // without them is a row the product cannot produce, and it made this
    // file the only exercise of the mint path.
    gameId: "blades",
    gameDayKind: "single" as const,
    ...over,
  });

  dates = [];
  for (let i = 0; i < 2; i++) {
    const id = mintId();
    await db(env)
      .insert(schema.pollDates)
      .values({ id, pollId: POLL, startsAt: START + i * 86_400, endsAt: START + i * 86_400 + 3600 });
    dates.push(id);
  }
}

function select(userId: string, values: string[]) {
  return discord.request({
    type: InteractionType.MESSAGE_COMPONENT,
    data: {
      custom_id: encodeCustomId({ action: "poll", arg: "select", target: POLL }),
      component_type: 3,
      values,
    },
    member: { user: { id: userId, username: userId, global_name: null }, roles: [] },
    guild_id: "g",
    message: { id: "msg-1", channel_id: "chan-1" },
  });
}

function pollRow() {
  return db(env).select().from(schema.datePolls).where(eq(schema.datePolls.id, POLL)).get();
}

function outcomes() {
  return db(env)
    .select()
    .from(schema.pollDates)
    .all()
    .then((rows) => rows.map((row) => row.outcome));
}

beforeEach(async () => {
  globalThis.fetch = (async () =>
    Response.json({ id: "msg-1", channel_id: "chan-1" })) as typeof fetch;

  for (const table of [
    "publications",
    "poll_responses",
    "poll_dates",
    "date_polls",
    "campaign_members",
    "jobs",
    "sessions",
    "campaigns",
    "users",
    "settings",
  ]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  await setSetting(env, SETTING_KEYS.guildId, "g1");
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("the GM gate", () => {
  it("does not close on a date the GM has not marked available", async () => {
    await seed({ optedIn: true });

    await app.fetch(await select("ada", [dates[0]!]), discord.env(env));
    await app.fetch(await select("bo", [dates[0]!]), discord.env(env));

    // A threshold crossed by players on a night the GM cannot make is not a win,
    // it is a scheduling accident — and a poll that closed itself on one would
    // have to be reopened by hand.
    expect(await pollRow()).toMatchObject({ status: "open" });
    expect(await outcomes()).toEqual(["open", "open"]);
  });

  it("closes when the GM is one of the people who said yes", async () => {
    await seed({ optedIn: true });

    await app.fetch(await select(GM, [dates[0]!]), discord.env(env));
    await app.fetch(await select("ada", [dates[0]!]), discord.env(env));

    expect(await pollRow()).toMatchObject({ status: "closed" });
    expect(await outcomes()).toEqual(["won", "lost"]);
  });

  it("waits when the campaign has no GM at all", async () => {
    await seed({ optedIn: true });
    await db(env)
      .delete(schema.campaignMembers)
      .where(eq(schema.campaignMembers.userId, GM));

    await app.fetch(await select("ada", [dates[0]!]), discord.env(env));
    await app.fetch(await select("bo", [dates[0]!]), discord.env(env));

    expect(await pollRow()).toMatchObject({ status: "open" });
  });
});

describe("the opt-in", () => {
  it("never resolves an opted-out campaign, however the tallies land", async () => {
    await seed({ optedIn: false });

    await app.fetch(await select(GM, [dates[0]!]), discord.env(env));
    await app.fetch(await select("ada", [dates[0]!]), discord.env(env));
    await app.fetch(await select("bo", [dates[0]!]), discord.env(env));

    expect(await pollRow()).toMatchObject({ status: "open" });
  });

  it("reads the flag live, so turning it off stops the next click", async () => {
    await seed({ optedIn: true });
    await app.fetch(await select(GM, [dates[0]!]), discord.env(env));

    await db(env)
      .update(schema.campaigns)
      .set({ autoResolvePolls: 0 })
      .where(eq(schema.campaigns.id, "umbra"));

    await app.fetch(await select("ada", [dates[0]!]), discord.env(env));

    // An admin who turns it off expects the next click to respect that, not the
    // next poll — which is why the flag is not copied onto the poll at open time.
    expect(await pollRow()).toMatchObject({ status: "open" });
  });

  it("never resolves a poll with no campaign", async () => {
    await seed({ optedIn: true }, { campaignId: null });

    await app.fetch(await select(GM, [dates[0]!]), discord.env(env));
    await app.fetch(await select("ada", [dates[0]!]), discord.env(env));

    expect(await pollRow()).toMatchObject({ status: "open" });
  });
});

describe("the rule", () => {
  it("waits when the rule proposes more than one date", async () => {
    await seed({ optedIn: true }, { winThreshold: 1 });

    await app.fetch(await select(GM, [dates[0]!, dates[1]!]), discord.env(env));

    // A single click cannot be said to have chosen between a tie. That is the
    // organiser's.
    expect(await pollRow()).toMatchObject({ status: "open" });
  });

  it("never acts on best_available, whatever the GM ticks", async () => {
    await seed({ optedIn: true }, { winRule: "best_available", winThreshold: null });

    await app.fetch(await select(GM, [dates[0]!]), discord.env(env));

    // `best_available` means "whatever did best", and one answer is trivially
    // the best — so it named a winner on the GM's very first click and closed
    // the poll before anybody else had seen it. It is also the schema default
    // and what every targeted /reschedule poll gets.
    expect(await pollRow()).toMatchObject({ status: "open" });
  });

  it("never acts on organiser_picks either", async () => {
    await seed({ optedIn: true }, { winRule: "organiser_picks", winThreshold: null });

    await app.fetch(await select(GM, [dates[0]!]), discord.env(env));
    await app.fetch(await select("ada", [dates[0]!]), discord.env(env));

    expect(await pollRow()).toMatchObject({ status: "open" });
  });

  it("still acts on a quorum of the roster", async () => {
    await seed({ optedIn: true }, { winRule: "quorum_of_roster", winThreshold: 0.6 });

    await app.fetch(await select(GM, [dates[0]!]), discord.env(env));
    expect(await pollRow()).toMatchObject({ status: "open" });

    await app.fetch(await select("ada", [dates[0]!]), discord.env(env));

    // Two of three clears 0.6 of a roster of three. A fixed bar is a real
    // moment, which is the whole difference.
    expect(await pollRow()).toMatchObject({ status: "closed" });
  });

  it("waits while nothing has won", async () => {
    await seed({ optedIn: true });

    await app.fetch(await select(GM, [dates[0]!]), discord.env(env));

    expect(await pollRow()).toMatchObject({ status: "open" });
  });
});

describe("the clicker's own response", () => {
  it("is the closed post", async () => {
    await seed({ optedIn: true });
    await app.fetch(await select(GM, [dates[0]!]), discord.env(env));

    const res = await app.fetch(await select("ada", [dates[0]!]), discord.env(env));
    const json = (await res.json()) as { type: number; data: { content: string; components: unknown[] } };

    // The click that crosses the line is the click that renders the closed
    // state, which is why applyOutcomes was split from the rendering.
    expect(json.type).toBe(InteractionResponseType.UPDATE_MESSAGE);
    expect(json.data.content).toContain("Closed");
    expect(json.data.components).toEqual([]);
  });
});
