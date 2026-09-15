import { env } from "cloudflare:test";
import { asc, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db, schema } from "../src/db/index.ts";
import { SETTING_KEYS, setSetting } from "../src/db/settings.ts";
import { mintId } from "../src/db/ids.ts";
import { createApp } from "../src/http/app.ts";
import { InteractionType } from "../src/discord/types.ts";
import { encodeCustomId } from "../src/discord/custom-id.ts";
import { fakeDiscord } from "./discord.ts";
import { materialiseHorizon } from "../src/campaigns/materialise.ts";

/**
 * A winning date that is an anchor rather than a day. Which branch a poll takes
 * is decided by the campaign's state and nothing else, and it cannot take both.
 */
const realFetch = globalThis.fetch;
const discord = await fakeDiscord();
const app = createApp();
const POLL = "pollid123456";
const ANCHOR = Date.parse("2026-10-06T19:00:00Z") / 1000;

let dates: string[] = [];

async function campaign(state: "FORMING" | "RUNNING") {
  await db(env).insert(schema.campaigns).values({
    id: "new-thing",
    name: "A New Thing",
    kind: "run",
    state,
    discordChannelId: "chan-1",
    intervalWeeks: 2,
  });
}

async function poll(over: Partial<typeof schema.datePolls.$inferInsert> = {}) {
  await db(env)
    .insert(schema.users)
    .values({ discordId: "opener", username: "opener", feedToken: "t-opener" })
    .onConflictDoNothing();
  await db(env)
    .insert(schema.games)
    .values({ id: "blades", name: "Blades in the Dark", minPlayers: 3, maxPlayers: 6 })
    .onConflictDoNothing();
  await db(env)
    .insert(schema.datePolls)
    .values({
      id: POLL,
      campaignId: "new-thing",
      gameId: "blades",
      gameDayKind: "single",
      discordChannelId: "chan-1",
      openedBy: "opener",
      winRule: "organiser_picks",
      ...over,
    });

  dates = [];
  for (const offset of [0, 7 * 86_400]) {
    const id = mintId();
    await db(env)
      .insert(schema.pollDates)
      .values({ id, pollId: POLL, startsAt: ANCHOR + offset, endsAt: ANCHOR + offset + 4 * 3600 });
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
    message: { id: "msg-1", channel_id: "chan-1" },
  });
}

async function canoniseWith(...pollDateIds: string[]) {
  await app.fetch(await click("canon"), discord.env(env));
  await app.fetch(await click("pick", pollDateIds), discord.env(env));
  await app.fetch(await click("apply"), discord.env(env));
}

function campaignRow() {
  return db(env)
    .select()
    .from(schema.campaigns)
    .where(eq(schema.campaigns.id, "new-thing"))
    .get();
}

function pollRow() {
  return db(env).select().from(schema.datePolls).where(eq(schema.datePolls.id, POLL)).get();
}

function days() {
  return db(env).select().from(schema.gameDays).all();
}

beforeEach(async () => {
  globalThis.fetch = (async () =>
    Response.json({ id: "msg-1", channel_id: "chan-1" })) as typeof fetch;

  for (const table of [
    "publications",
    "poll_responses",
    "poll_dates",
    "date_polls",
    "game_days",
    "campaign_members",
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

describe("a forming campaign's poll", () => {
  it("sets the anchor and mints no day", async () => {
    await campaign("FORMING");
    await poll();

    await canoniseWith(dates[0]!);

    expect(await campaignRow()).toMatchObject({ recurrenceAnchor: ANCHOR });
    // A campaign that has not started needs a slot, not a Saturday.
    expect(await days()).toEqual([]);
    expect(await pollRow()).toMatchObject({ status: "closed" });
  });

  it("produces the sessions the anchor implies on the next materialiser run", async () => {
    await campaign("FORMING");
    await poll();
    await canoniseWith(dates[0]!);

    await db(env)
      .update(schema.campaigns)
      .set({ state: "RUNNING" })
      .where(eq(schema.campaigns.id, "new-thing"));
    await setSetting(env, SETTING_KEYS.horizonSessions, 2);

    await materialiseHorizon(env, new Date("2026-09-14T12:00:00Z"));

    const sessions = await db(env)
      .select()
      .from(schema.sessions)
      .orderBy(asc(schema.sessions.startsAt))
      .all();

    // Nobody entered a date. The anchor plus the interval is the whole schedule.
    expect(sessions).toHaveLength(2);
    expect(sessions[1]!.startsAt - sessions[0]!.startsAt).toBe(14 * 86_400);
  });

  it("refuses two dates and leaves the poll open", async () => {
    await campaign("FORMING");
    await poll();

    await canoniseWith(dates[0]!, dates[1]!);

    // An anchor is a single date by definition. A tie goes back to the organiser
    // rather than the code silently taking the first.
    expect(await campaignRow()).toMatchObject({ recurrenceAnchor: null });
    expect(await pollRow()).toMatchObject({ status: "open" });
    expect(await days()).toEqual([]);
  });

  it("takes an anchor that is already in the past", async () => {
    await campaign("FORMING");
    await db(env)
      .insert(schema.users)
      .values({ discordId: "opener", username: "opener", feedToken: "t-opener" });
    await db(env)
      .insert(schema.datePolls)
      .values({
        id: POLL,
        campaignId: "new-thing",
        gameId: null,
        discordChannelId: "chan-1",
        openedBy: "opener",
        winRule: "organiser_picks",
      });
    const past = Date.parse("2024-01-06T19:00:00Z") / 1000;
    const id = mintId();
    await db(env)
      .insert(schema.pollDates)
      .values({ id, pollId: POLL, startsAt: past, endsAt: past + 4 * 3600 });

    await canoniseWith(id);

    // Phase 2's recurrence is an anchor plus an interval: the anchor is where
    // the count starts, not when the next session is.
    expect(await campaignRow()).toMatchObject({ recurrenceAnchor: past });
  });
});

describe("everything else still mints days", () => {
  it("a running campaign's poll, because it already has its slot", async () => {
    await campaign("RUNNING");
    await poll();

    await canoniseWith(dates[0]!);

    expect(await campaignRow()).toMatchObject({ recurrenceAnchor: null });
    expect(await days()).toHaveLength(1);
  });

  it("a poll with no campaign at all", async () => {
    await poll({ campaignId: null });

    await canoniseWith(dates[0]!);

    expect(await days()).toHaveLength(1);
  });
});
