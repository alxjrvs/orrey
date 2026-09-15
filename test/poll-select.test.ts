import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { db, schema } from "../src/db/index.ts";
import { mintId } from "../src/db/ids.ts";
import { createApp } from "../src/http/app.ts";
import { InteractionResponseType, InteractionType } from "../src/discord/types.ts";
import { encodeCustomId } from "../src/discord/custom-id.ts";
import { fakeDiscord } from "./discord.ts";

/**
 * The answer replaces the last one. Discord sends the complete selection every
 * time, so anything toggle-shaped here is a bug that only shows up when somebody
 * changes their mind.
 */
const discord = await fakeDiscord();
const app = createApp();
const POLL = "pollid123456";
const START = Date.parse("2026-10-01T19:00:00Z") / 1000;

let dates: string[] = [];

function lock() {
  return env.POLL_LOCK.get(env.POLL_LOCK.idFromName(POLL));
}

const actor = (id: string) => ({ id, username: `p${id}`, global_name: null });

async function seed() {
  await db(env)
    .insert(schema.campaigns)
    .values({ id: "age-of-umbra", name: "Age of Umbra", kind: "run", state: "RUNNING" });
  await db(env)
    .insert(schema.datePolls)
    .values({ id: POLL, campaignId: "age-of-umbra", discordChannelId: "chan-1" });

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

function answers(userId?: string) {
  return db(env)
    .select()
    .from(schema.pollResponses)
    .all()
    .then((rows) => rows.filter((row) => !userId || row.userId === userId));
}

function click(custom_id: string, values: string[] | undefined, userId = "ada") {
  return discord.request({
    type: InteractionType.MESSAGE_COMPONENT,
    data: { custom_id, component_type: 3, ...(values ? { values } : {}) },
    member: { user: { id: userId, username: userId, global_name: null }, roles: [] },
    guild_id: "g",
    // The fixture's message content is a lie on purpose: nothing may read it.
    message: { id: "msg-1", channel_id: "chan-1" },
  });
}

beforeEach(async () => {
  for (const table of [
    "poll_responses",
    "poll_dates",
    "date_polls",
    "sessions",
    "campaigns",
    "users",
  ]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  await seed();
});

describe("the write is a replacement", () => {
  it("records what was chosen", async () => {
    await lock().select({ pollId: POLL, actor: actor("ada"), pollDateIds: [dates[0]!, dates[1]!] });

    expect((await answers("ada")).map((row) => row.pollDateId).sort()).toEqual(
      [dates[0]!, dates[1]!].sort(),
    );
  });

  it("removes the dates that were dropped", async () => {
    await lock().select({ pollId: POLL, actor: actor("ada"), pollDateIds: [dates[0]!, dates[1]!] });

    await lock().select({ pollId: POLL, actor: actor("ada"), pollDateIds: [dates[1]!] });

    // A toggle would have left the first one standing, and the person who just
    // said "actually only Tuesday" would still be counted for Monday.
    expect((await answers("ada")).map((row) => row.pollDateId)).toEqual([dates[1]!]);
  });

  it("treats an empty selection as an answer and clears the lot", async () => {
    await lock().select({ pollId: POLL, actor: actor("ada"), pollDateIds: dates });

    await lock().select({ pollId: POLL, actor: actor("ada"), pollDateIds: [] });

    // "None of these work" is a real answer. Reading it as "said nothing" would
    // silently keep the answer they just withdrew.
    expect(await answers("ada")).toEqual([]);
  });

  it("touches nobody else's answers", async () => {
    await lock().select({ pollId: POLL, actor: actor("bo"), pollDateIds: [dates[0]!] });

    await lock().select({ pollId: POLL, actor: actor("ada"), pollDateIds: [] });

    expect((await answers("bo")).map((row) => row.pollDateId)).toEqual([dates[0]!]);
  });

  it("ignores a date that does not belong to this poll", async () => {
    const other = mintId();
    await db(env).insert(schema.datePolls).values({ id: other });
    const strayId = mintId();
    await db(env)
      .insert(schema.pollDates)
      .values({ id: strayId, pollId: other, startsAt: START, endsAt: START + 1 });

    await lock().select({
      pollId: POLL,
      actor: actor("ada"),
      pollDateIds: [dates[0]!, strayId],
    });

    expect((await answers("ada")).map((row) => row.pollDateId)).toEqual([dates[0]!]);
  });

  it("produces one correct tally when two people answer at once", async () => {
    await Promise.all([
      lock().select({ pollId: POLL, actor: actor("ada"), pollDateIds: [dates[0]!] }),
      lock().select({ pollId: POLL, actor: actor("bo"), pollDateIds: [dates[0]!] }),
      lock().select({ pollId: POLL, actor: actor("cy"), pollDateIds: [dates[0]!, dates[1]!] }),
    ]);

    const rows = await answers();
    expect(rows.filter((row) => row.pollDateId === dates[0])).toHaveLength(3);
    expect(rows.filter((row) => row.pollDateId === dates[1])).toHaveLength(1);
  });

  it("says nothing about a poll that is gone", async () => {
    await env.DB.prepare("DELETE FROM date_polls").run();
    expect(
      await lock().select({ pollId: POLL, actor: actor("ada"), pollDateIds: [] }),
    ).toBeUndefined();
  });
});

describe("the click", () => {
  it("rewrites the message it came from", async () => {
    const res = await app.fetch(
      await click(
        encodeCustomId({ action: "poll", arg: "select", target: POLL }),
        [dates[1]!],
      ),
      discord.env(env),
    );

    const json = (await res.json()) as { type: number; data: { content: string } };
    expect(json.type).toBe(InteractionResponseType.UPDATE_MESSAGE);
    expect(json.data.content).toContain("Which days work?");
    expect((await answers("ada")).map((row) => row.pollDateId)).toEqual([dates[1]!]);
  });

  it("clears on a select that came back empty", async () => {
    await lock().select({ pollId: POLL, actor: actor("ada"), pollDateIds: dates });

    await app.fetch(
      await click(encodeCustomId({ action: "poll", arg: "select", target: POLL }), []),
      discord.env(env),
    );

    expect(await answers("ada")).toEqual([]);
  });

  it("re-reads without writing on Refresh", async () => {
    await lock().select({ pollId: POLL, actor: actor("ada"), pollDateIds: [dates[0]!] });

    const res = await app.fetch(
      await click(encodeCustomId({ action: "poll", arg: "refresh", target: POLL }), undefined),
      discord.env(env),
    );

    expect(((await res.json()) as { type: number }).type).toBe(
      InteractionResponseType.UPDATE_MESSAGE,
    );
    expect((await answers("ada")).map((row) => row.pollDateId)).toEqual([dates[0]!]);
  });

  it("never writes one person's answer into the post everybody shares", async () => {
    await lock().select({ pollId: POLL, actor: actor("ada"), pollDateIds: [dates[2]!] });

    const res = await app.fetch(
      await click(encodeCustomId({ action: "poll", arg: "refresh", target: POLL }), undefined),
      discord.env(env),
    );

    const json = (await res.json()) as {
      data: { components: { components: { options: { value: string; default?: boolean }[] }[] }[] };
    };
    const options = json.data.components[0]?.components[0]?.options ?? [];

    // This answer is an UPDATE_MESSAGE: it rewrites the one post in the channel.
    // A prefill computed from whoever clicked would be stamped into it, and the
    // next person to open the select would find somebody else's answer ticked.
    // Their own answer is in D1 and shows in the tallies.
    for (const option of options) expect(option.default).toBeUndefined();
  });

  it("answers the retired-post response for a poll that no longer exists", async () => {
    await env.DB.prepare("DELETE FROM date_polls").run();

    const res = await app.fetch(
      await click(encodeCustomId({ action: "poll", arg: "select", target: POLL }), []),
      discord.env(env),
    );

    const json = (await res.json()) as { type: number; data: { content: string } };
    expect(json.type).toBe(InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE);
    expect(json.data.content).toContain("retired");
  });

  it("answers the retired-post response for Canonise, which has no slice yet", async () => {
    const res = await app.fetch(
      await click(encodeCustomId({ action: "poll", arg: "canon", target: POLL }), undefined),
      discord.env(env),
    );

    // Loose, and loose in a branch rather than in a channel.
    expect(((await res.json()) as { data: { content: string } }).data.content).toContain("retired");
  });

  it("remembers who clicked, because identity is the Discord id", async () => {
    await app.fetch(
      await click(
        encodeCustomId({ action: "poll", arg: "select", target: POLL }),
        [dates[0]!],
        "9001",
      ),
      discord.env(env),
    );

    expect(
      await db(env).select().from(schema.users).where(eq(schema.users.discordId, "9001")).get(),
    ).toBeTruthy();
  });
});
