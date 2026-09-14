import { env } from "cloudflare:test";
import { asc, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { db, schema } from "../src/db/index.ts";
import { SETTING_KEYS, setSetting } from "../src/db/settings.ts";
import { mintId } from "../src/db/ids.ts";
import { createApp } from "../src/http/app.ts";
import { InteractionResponseType, InteractionType, MessageFlags } from "../src/discord/types.ts";
import { encodeCustomId } from "../src/discord/custom-id.ts";
import { fakeDiscord } from "./discord.ts";

/**
 * The rule proposes, the organiser disposes. The Canonise button sits on a post
 * the whole server can see, so the check in front of it is the only thing
 * between a player and closing a poll.
 */
const discord = await fakeDiscord();
const app = createApp();
const POLL = "pollid123456";
const START = Date.parse("2026-10-01T19:00:00Z") / 1000;
const ORGANISER_ROLE = "role-organiser";

let dates: string[] = [];

async function seed(over: Partial<typeof schema.datePolls.$inferInsert> = {}) {
  await db(env)
    .insert(schema.games)
    .values({ id: "blades", name: "Blades in the Dark", minPlayers: 3, maxPlayers: 6 })
    .onConflictDoNothing();
  await db(env)
    .insert(schema.campaigns)
    .values({ id: "age-of-umbra", name: "Age of Umbra", kind: "run", state: "RUNNING" });
  await db(env)
    .insert(schema.users)
    .values({ discordId: "opener", username: "opener", feedToken: "t-opener" });
  await db(env)
    .insert(schema.datePolls)
    .values({
      id: POLL,
      campaignId: "age-of-umbra",
      discordChannelId: "chan-1",
      openedBy: "opener",
      winRule: "best_available",
      // An untargeted poll names its game and its kind, because `openPoll`
      // refuses one that does not — `needs-game`, `needs-kind`. A fixture
      // without them is a row the product cannot produce, and it made this
      // file the only exercise of the mint path.
      gameId: "blades",
      gameDayKind: "single" as const,
      ...over,
    });

  dates = [];
  for (let i = 0; i < 3; i++) {
    const id = mintId();
    await db(env)
      .insert(schema.pollDates)
      .values({
        id,
        pollId: POLL,
        startsAt: START + i * 86_400,
        endsAt: START + i * 86_400 + 14_400,
      });
    dates.push(id);
  }
}

async function yes(pollDateId: string, ...userIds: string[]) {
  for (const userId of userIds) {
    await db(env)
      .insert(schema.users)
      .values({ discordId: userId, username: userId, feedToken: `t-${userId}` })
      .onConflictDoNothing();
    await db(env).insert(schema.pollResponses).values({ pollDateId, userId });
  }
}

function click(arg: string, userId: string, roles: string[] = [], values?: string[]) {
  return discord.request({
    type: InteractionType.MESSAGE_COMPONENT,
    data: {
      custom_id: encodeCustomId({ action: "poll", arg, target: POLL }),
      component_type: values ? 3 : 2,
      ...(values ? { values } : {}),
    },
    member: { user: { id: userId, username: userId, global_name: null }, roles },
    guild_id: "g",
    message: { id: "msg-1", channel_id: "chan-1" },
  });
}

async function outcomes() {
  const rows = await db(env)
    .select()
    .from(schema.pollDates)
    .where(eq(schema.pollDates.pollId, POLL))
    .orderBy(asc(schema.pollDates.startsAt))
    .all();
  return rows.map((row) => row.outcome);
}

function status() {
  return db(env)
    .select({ status: schema.datePolls.status })
    .from(schema.datePolls)
    .where(eq(schema.datePolls.id, POLL))
    .get()
    .then((row) => row?.status);
}

beforeEach(async () => {
  for (const table of [
    "poll_responses",
    "poll_dates",
    "date_polls",
    "campaigns",
    "users",
    "settings",
  ]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  await setSetting(env, SETTING_KEYS.guildId, "g1");
  await setSetting(env, SETTING_KEYS.organiserRoleId, ORGANISER_ROLE);
  await seed();
});

describe("who may close a poll", () => {
  it("refuses a player, ephemerally, and writes nothing", async () => {
    await yes(dates[1]!, "a", "b");

    const res = await app.fetch(await click("canon", "player"), discord.env(env));
    const json = (await res.json()) as { type: number; data: { content: string; flags: number } };

    // Ephemeral and not UPDATE_MESSAGE: a player clicking this must not change
    // what everybody else in the channel is looking at.
    expect(json.type).toBe(InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE);
    expect(json.data.flags & MessageFlags.EPHEMERAL).toBeTruthy();
    expect(json.data.content).toContain("organiser");
    expect(await outcomes()).toEqual(["open", "open", "open"]);
    expect(await status()).toBe("open");
  });

  it("lets the opener through without the role", async () => {
    const res = await app.fetch(await click("canon", "opener"), discord.env(env));
    expect(((await res.json()) as { type: number }).type).toBe(
      InteractionResponseType.UPDATE_MESSAGE,
    );
  });

  it("lets somebody holding the organiser role through", async () => {
    const res = await app.fetch(
      await click("canon", "someone-else", [ORGANISER_ROLE]),
      discord.env(env),
    );
    expect(((await res.json()) as { type: number }).type).toBe(
      InteractionResponseType.UPDATE_MESSAGE,
    );
  });

  it("reads the roles off the interaction Discord signed, and asks Discord nothing", async () => {
    // The console's OAuth scope is `identify`; roles here come from the payload
    // the endpoint already verified. No REST call, no `guilds` scope, and a
    // failing fetch proves it.
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error("nothing here may call Discord");
    }) as typeof fetch;
    try {
      const res = await app.fetch(
        await click("canon", "someone-else", [ORGANISER_ROLE]),
        discord.env(env),
      );
      expect(res.status).toBe(200);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("fails closed when nobody has seeded the role id", async () => {
    await env.DB.prepare("DELETE FROM settings WHERE key = ?")
      .bind(SETTING_KEYS.organiserRoleId)
      .run();

    const res = await app.fetch(
      await click("canon", "someone-else", [ORGANISER_ROLE]),
      discord.env(env),
    );

    // Nobody but the opener, rather than everybody — wrong in a way somebody
    // notices immediately.
    expect(((await res.json()) as { data: { content: string } }).data.content).toContain(
      "organiser",
    );
  });
});

describe("the override", () => {
  it("opens with what the rule picked", async () => {
    await yes(dates[1]!, "a", "b");
    await yes(dates[0]!, "a");

    const res = await app.fetch(await click("canon", "opener"), discord.env(env));
    const json = (await res.json()) as {
      data: {
        content: string;
        components: { components: { options?: { value: string; default: boolean }[] }[] }[];
      };
    };

    expect(json.data.content).toContain("Closing the poll");
    const options = json.data.components[0]?.components[0]?.options ?? [];
    expect(options.find((o) => o.value === dates[1])?.default).toBe(true);
    expect(options.find((o) => o.value === dates[0])?.default).toBe(false);
  });

  it("opens with nothing chosen when the rule had no opinion", async () => {
    await db(env)
      .update(schema.datePolls)
      .set({ winRule: "organiser_picks" })
      .where(eq(schema.datePolls.id, POLL));
    await yes(dates[0]!, "a", "b", "c");

    const res = await app.fetch(await click("canon", "opener"), discord.env(env));
    const json = (await res.json()) as { data: { content: string } };

    expect(json.data.content).toContain("The rule picked nothing");
    expect(await outcomes()).toEqual(["lost", "lost", "lost"]);
  });

  it("does not close anything on its own", async () => {
    await yes(dates[1]!, "a", "b");
    await app.fetch(await click("canon", "opener"), discord.env(env));

    // Outcomes are provisional exactly as long as the poll is open; `status` is
    // what says it has been decided.
    expect(await status()).toBe("open");
  });

  it("keeps the organiser's choice over the rule's", async () => {
    await yes(dates[1]!, "a", "b");
    await app.fetch(await click("canon", "opener"), discord.env(env));

    await app.fetch(await click("pick", "opener", [], [dates[2]!]), discord.env(env));

    // The rule picked d1. The organiser picked d2. The organiser wins — that is
    // the whole reason there are two clicks.
    expect(await outcomes()).toEqual(["lost", "lost", "won"]);
    expect(await status()).toBe("open");
  });

  it("refuses a player's pick", async () => {
    await yes(dates[1]!, "a", "b");
    await app.fetch(await click("canon", "opener"), discord.env(env));
    const before = await outcomes();

    await app.fetch(await click("pick", "player", [], [dates[0]!]), discord.env(env));

    // The organiser staged d1. A player naming d0 changes nothing at all.
    expect(before).toEqual(["lost", "won", "lost"]);
    expect(await outcomes()).toEqual(before);
  });
});

describe("apply", () => {
  it("closes the poll and leaves no date open", async () => {
    await yes(dates[1]!, "a", "b");
    await app.fetch(await click("canon", "opener"), discord.env(env));

    const res = await app.fetch(await click("apply", "opener"), discord.env(env));
    const json = (await res.json()) as { type: number; data: { components: unknown[] } };

    expect(await status()).toBe("closed");
    // A poll that closed without saying so about a date is a poll nobody can
    // read afterwards.
    expect(await outcomes()).toEqual(["lost", "won", "lost"]);
    expect(json.type).toBe(InteractionResponseType.UPDATE_MESSAGE);
    expect(json.data.components).toEqual([]);
  });

  it("acts on what the picks wrote, not on what the message says", async () => {
    await yes(dates[0]!, "a", "b");
    await app.fetch(await click("canon", "opener"), discord.env(env));
    await app.fetch(await click("pick", "opener", [], [dates[2]!]), discord.env(env));

    await app.fetch(await click("apply", "opener"), discord.env(env));

    // A button click carries no select values, and Orrey never reads a message
    // back. D1 is the only place this state is allowed to live.
    expect(await outcomes()).toEqual(["lost", "lost", "won"]);
  });

  it("changes nothing on a second apply", async () => {
    await yes(dates[1]!, "a", "b");
    await app.fetch(await click("canon", "opener"), discord.env(env));
    await app.fetch(await click("apply", "opener"), discord.env(env));

    await app.fetch(await click("pick", "opener", [], [dates[0]!]), discord.env(env));
    await app.fetch(await click("apply", "opener"), discord.env(env));

    expect(await outcomes()).toEqual(["lost", "won", "lost"]);
  });

  it("can close a poll with nothing winning", async () => {
    await db(env)
      .update(schema.datePolls)
      .set({ winRule: "organiser_picks" })
      .where(eq(schema.datePolls.id, POLL));
    await app.fetch(await click("canon", "opener"), discord.env(env));

    await app.fetch(await click("apply", "opener"), discord.env(env));

    // "No day works" is a real outcome, and the next slice's consequences look
    // for `won` rows rather than for a status.
    expect(await status()).toBe("closed");
    expect(await outcomes()).toEqual(["lost", "lost", "lost"]);
  });

  it("shows a closed poll rather than offering to decide it again", async () => {
    await app.fetch(await click("canon", "opener"), discord.env(env));
    await app.fetch(await click("apply", "opener"), discord.env(env));

    const res = await app.fetch(await click("canon", "opener"), discord.env(env));
    const json = (await res.json()) as { data: { content: string; components: unknown[] } };

    expect(json.data.content).toContain("Closed");
    expect(json.data.components).toEqual([]);
  });
});
