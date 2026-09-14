import { env } from "cloudflare:test";
import { asc, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db, schema } from "../src/db/index.ts";
import { mintStatements } from "../src/polls/game-days.ts";
import { SETTING_KEYS, setSetting } from "../src/db/settings.ts";
import { mintId } from "../src/db/ids.ts";
import { createApp } from "../src/http/app.ts";
import { InteractionType } from "../src/discord/types.ts";
import { encodeCustomId } from "../src/discord/custom-id.ts";
import { fakeDiscord } from "./discord.ts";
import { drainJobs } from "../src/jobs/drain.ts";

/**
 * One day per winning date. A multi-kind poll can win more than one, and then
 * that is genuinely two days — which is the case #37 is written around.
 */
const realFetch = globalThis.fetch;
const discord = await fakeDiscord();
const app = createApp();
const POLL = "pollid123456";
const NOW = Math.floor(Date.now() / 1000);
const DAY = 86_400;

let calls: { path: string; body: Record<string, unknown> }[] = [];
let dates: string[] = [];

async function seed(over: Partial<typeof schema.datePolls.$inferInsert> = {}) {
  await db(env)
    .insert(schema.users)
    .values({ discordId: "opener", username: "opener", feedToken: "t-opener" });
  await db(env)
    .insert(schema.games)
    .values({ id: "blades", name: "Blades in the Dark", minPlayers: 3, maxPlayers: 6 });
  await db(env)
    .insert(schema.datePolls)
    .values({
      id: POLL,
      gameId: "blades",
      gameDayKind: "multi",
      discordChannelId: "chan-scheduling",
      openedBy: "opener",
      winRule: "organiser_picks",
      ...over,
    });

  dates = [];
  for (const offset of [30, 31]) {
    const id = mintId();
    const at = NOW + offset * DAY;
    await db(env)
      .insert(schema.pollDates)
      .values({ id, pollId: POLL, startsAt: at, endsAt: at + 6 * 3600 });
    dates.push(id);
  }
}

function click(arg: string, values?: string[]) {
  return discord.request({
    type: InteractionType.MESSAGE_COMPONENT,
    data: {
      custom_id: encodeCustomId({ action: "poll", arg, target: POLL }),
      component_type: values ? 3 : 2,
      ...(values ? { values } : {}),
    },
    member: { user: { id: "opener", username: "opener", global_name: null }, roles: [] },
    guild_id: "g",
    message: { id: "msg-1", channel_id: "chan-scheduling" },
  });
}

async function canoniseWith(...pollDateIds: string[]) {
  await app.fetch(await click("canon"), discord.env(env));
  await app.fetch(await click("pick", pollDateIds), discord.env(env));
  await app.fetch(await click("apply"), discord.env(env));
}

function days() {
  return db(env).select().from(schema.gameDays).orderBy(asc(schema.gameDays.startsAt)).all();
}

function pollDates() {
  return db(env)
    .select()
    .from(schema.pollDates)
    .where(eq(schema.pollDates.pollId, POLL))
    .orderBy(asc(schema.pollDates.startsAt))
    .all();
}

function announceJobs() {
  return db(env)
    .select()
    .from(schema.jobs)
    .all()
    .then((rows) => rows.filter((row) => row.kind === "gameday.announce"));
}

beforeEach(async () => {
  calls = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    calls.push({
      path: url.pathname.replace("/api/v10", ""),
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
    });
    return Response.json({ id: `msg-${calls.length}`, channel_id: "chan-scheduling" });
  }) as typeof fetch;

  for (const table of [
    "publications",
    "poll_responses",
    "poll_dates",
    "date_polls",
    "game_days",
    "jobs",
    "sessions",
    "campaigns",
    "games",
    "users",
    "settings",
  ]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  await setSetting(env, SETTING_KEYS.guildId, "g1");
  await setSetting(env, SETTING_KEYS.schedulingChannelId, "chan-scheduling");
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("the mint", () => {
  it("makes one day per winning date and arms one announcement each", async () => {
    await seed();

    await canoniseWith(dates[0]!, dates[1]!);

    const minted = await days();
    expect(minted).toHaveLength(2);
    expect(minted[0]).toMatchObject({
      state: "PROPOSED",
      kind: "multi",
      title: "Blades in the Dark",
    });
    expect(await announceJobs()).toHaveLength(2);
  });

  it("carries the poll's game onto the day it mints", async () => {
    await seed();

    await canoniseWith(dates[0]!);

    // The game was read once for a title and then dropped, so every day this
    // path minted had `game_id` NULL — which `dayWithCapacity` reads as "however
    // many turn up". A six-player table seated nine, and the waitlist never
    // engaged on any day the product actually creates.
    expect((await days())[0]).toMatchObject({ gameId: "blades" });
  });

  it("refuses to mint a single day with no game", async () => {
    await seed({ gameDayKind: "single", gameId: null });

    // `singleNamesGame`'s docstring says the rule lives in the one place that
    // writes the row, because SQLite cannot add the CHECK without a rebuild and
    // D1 would cascade the signups away. Until now it lived nowhere.
    //
    // Asserted against `mintStatements` rather than through a click, because a
    // throw inside an interaction is a 500 and this is a guard against a row
    // `openPoll` already refuses to create — `needs-game` on an untargeted poll.
    await expect(mintStatements(env, POLL, [dates[0]!])).rejects.toThrow(
      /single day with no game/,
    );
    expect(await days()).toEqual([]);
  });

  it("points each poll_date at the day it minted", async () => {
    await seed();

    await canoniseWith(dates[0]!, dates[1]!);

    const rows = await pollDates();
    const minted = await days();
    expect(rows[0]?.gameDayId).toBe(minted[0]?.id);
    expect(rows[1]?.gameDayId).toBe(minted[1]?.id);
    expect(rows[0]?.gameDayId).not.toBe(rows[1]?.gameDayId);
  });

  it("takes the day's length from the date, not from a constant", async () => {
    await seed();

    await canoniseWith(dates[0]!);

    const [minted] = await days();
    expect(minted!.endsAt - minted!.startsAt).toBe(6 * 3600);
  });

  it("mints nothing when nothing won, and still closes", async () => {
    await seed();

    await canoniseWith();

    expect(await days()).toEqual([]);
    expect(
      await db(env).select().from(schema.datePolls).where(eq(schema.datePolls.id, POLL)).get(),
    ).toMatchObject({ status: "closed" });
  });

  it("mints nothing for a poll that was moving a session", async () => {
    await db(env)
      .insert(schema.campaigns)
      .values({ id: "umbra", name: "Age of Umbra", kind: "run", state: "RUNNING" });
    await db(env).insert(schema.sessions).values({
      id: "umbra-s1",
      kind: "campaign_session",
      campaignId: "umbra",
      number: 1,
      startsAt: NOW + 7 * DAY,
      endsAt: NOW + 7 * DAY + 4 * 3600,
      location: "The Wreck",
    });
    await seed({ targetSessionId: "umbra-s1", gameId: null, gameDayKind: null });

    await canoniseWith(dates[0]!);

    // A targeted poll takes the move path. Minting a day for it would be
    // inventing an event nobody asked for.
    expect(await days()).toEqual([]);
  });

  it("does not mint a second day when Apply runs again", async () => {
    await seed();
    await canoniseWith(dates[0]!);

    await app.fetch(await click("apply"), discord.env(env));

    expect(await days()).toHaveLength(1);
  });
});

describe("the announcement", () => {
  it("posts one new message in the scheduling channel", async () => {
    await seed();
    await canoniseWith(dates[0]!);
    calls = [];

    await drainJobs(env);

    expect(calls).toMatchObject([{ path: "/channels/chan-scheduling/messages" }]);
    expect(String(calls[0]?.body.content)).toContain("A day is on.");
    expect(String(calls[0]?.body.content)).toContain("Blades in the Dark");
  });

  it("says only that the day exists", async () => {
    await seed();
    await canoniseWith(dates[0]!);
    await drainJobs(env);

    // A PROPOSED day has no capacity, no host and no signup buttons. Announcing
    // a seat that cannot be claimed would be worse than saying less.
    expect(calls[0]?.body.components).toEqual([]);
    expect(String(calls[0]?.body.content)).toContain("Seats open when the day is set up");
  });

  it("posts once on a redelivery", async () => {
    await seed();
    await canoniseWith(dates[0]!);
    await drainJobs(env);
    calls = [];

    await db(env).update(schema.jobs).set({ state: "pending", attempts: 0 });
    await drainJobs(env);

    expect(calls).toEqual([]);
  });

  it("names several tables when the poll said several", async () => {
    await seed();
    await canoniseWith(dates[0]!);
    await drainJobs(env);

    expect(String(calls[0]?.body.content)).toContain("Several tables.");
  });
});

describe("the claim this file makes", () => {
  it("mints the day in the same batch that closes the poll", async () => {
    await seed({ gameDayKind: "single" });

    await canoniseWith(dates[0]!);

    // "The mint happens inside the same batch that writes the outcomes, so a
    // poll cannot end up closed with winners and no days." It was not true: the
    // close committed in one batch and the mint ran in another, and Apply's own
    // guard refuses a closed poll — so a crash in between lost the day for good.
    // Asserting the pairing rather than the ordering, because the ordering is
    // what a batch removes.
    expect(
      await db(env).select().from(schema.datePolls).where(eq(schema.datePolls.id, POLL)).get(),
    ).toMatchObject({ status: "closed" });
    expect(await days()).toHaveLength(1);
  });

  it("leaves no won date without a day", async () => {
    await seed();

    await canoniseWith(dates[0]!, dates[1]!);

    const won = (await pollDates()).filter((date) => date.outcome === "won");
    expect(won).toHaveLength(2);
    for (const date of won) expect(date.gameDayId).not.toBeNull();
  });
});
