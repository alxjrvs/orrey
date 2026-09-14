import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db, schema } from "../src/db/index.ts";
import { SETTING_KEYS, setSetting } from "../src/db/settings.ts";
import { createApp } from "../src/http/app.ts";
import { InteractionResponseType, InteractionType } from "../src/discord/types.ts";
import { decodeCustomId, encodeCustomId } from "../src/discord/custom-id.ts";
import { fakeDiscord } from "./discord.ts";
import { drainJobs } from "../src/jobs/drain.ts";
import { MAX_CHOICES } from "../src/commands/whos-in.ts";

/**
 * Autocomplete a session, open a poll. The refusal that matters is the second
 * poll on the same session — and it comes from the index, not from a prior read.
 */
const realFetch = globalThis.fetch;
const discord = await fakeDiscord();
const app = createApp();
const NOW = Math.floor(Date.now() / 1000);
const DAY = 86_400;

let calls: string[] = [];

async function campaign(id: string, name: string, channelId: string | null = "chan-1") {
  await db(env)
    .insert(schema.campaigns)
    .values({ id, name, kind: "run", state: "RUNNING", discordChannelId: channelId });
}

async function member(campaignId: string, userId: string) {
  await db(env)
    .insert(schema.users)
    .values({ discordId: userId, username: userId, feedToken: `t-${userId}` })
    .onConflictDoNothing();
  await db(env).insert(schema.campaignMembers).values({ campaignId, userId });
}

async function session(campaignId: string, number: number, inDays: number) {
  const startsAt = NOW + inDays * DAY;
  const id = `${campaignId}-s${number}`;
  await db(env).insert(schema.sessions).values({
    id,
    kind: "campaign_session",
    campaignId,
    number,
    startsAt,
    endsAt: startsAt + 4 * 3600,
    location: "The Wreck",
  });
  return id;
}

function command(sessionId?: string, userId = "ada") {
  return discord.request({
    type: InteractionType.APPLICATION_COMMAND,
    data: {
      name: "reschedule",
      ...(sessionId ? { options: [{ name: "event", value: sessionId }] } : {}),
    },
    member: { user: { id: userId, username: userId, global_name: null }, roles: [] },
    guild_id: "g",
  });
}

function submit(sessionId: string, text: string, userId = "ada") {
  return discord.request({
    type: InteractionType.MODAL_SUBMIT,
    data: {
      custom_id: encodeCustomId({ action: "poll-open", target: sessionId }),
      components: [{ type: 1, components: [{ custom_id: "dates", value: text }] }],
    },
    member: { user: { id: userId, username: userId, global_name: null }, roles: [] },
    guild_id: "g",
  });
}

function polls() {
  return db(env).select().from(schema.datePolls).all();
}

beforeEach(async () => {
  calls = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    calls.push(url.pathname.replace("/api/v10", ""));
    return Response.json({ id: `msg-${calls.length}`, channel_id: "chan-1" });
  }) as typeof fetch;

  for (const table of [
    "publications",
    "poll_responses",
    "poll_dates",
    "date_polls",
    "attendance",
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
  await setSetting(env, SETTING_KEYS.timezone, "Europe/London");
  await campaign("umbra", "Age of Umbra");
  await member("umbra", "ada");
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("the autocomplete", () => {
  it("offers only sessions the caller is rostered on", async () => {
    await session("umbra", 1, 7);
    await campaign("secret", "Somebody Else's Game", "chan-2");
    await member("secret", "bo");
    await session("secret", 1, 3);

    const res = await app.fetch(
      await discord.request({
        type: InteractionType.APPLICATION_COMMAND_AUTOCOMPLETE,
        data: { name: "reschedule", options: [{ name: "event", value: "", focused: true }] },
        member: { user: { id: "ada", username: "ada", global_name: null }, roles: [] },
        guild_id: "g",
      }),
      discord.env(env),
    );

    const json = (await res.json()) as { data: { choices: { value: string }[] } };
    expect(json.data.choices.map((choice) => choice.value)).toEqual(["umbra-s1"]);
  });

  it("caps at what Discord accepts", async () => {
    for (let n = 1; n <= MAX_CHOICES + 5; n++) await session("umbra", n, n);

    const res = await app.fetch(
      await discord.request({
        type: InteractionType.APPLICATION_COMMAND_AUTOCOMPLETE,
        data: { name: "reschedule", options: [{ name: "event", value: "", focused: true }] },
        member: { user: { id: "ada", username: "ada", global_name: null }, roles: [] },
        guild_id: "g",
      }),
      discord.env(env),
    );

    // It fires on every keystroke, so it is one indexed query and one cap.
    expect(((await res.json()) as { data: { choices: unknown[] } }).data.choices).toHaveLength(
      MAX_CHOICES,
    );
  });
});

describe("the command", () => {
  it("opens a modal carrying the session through the round trip", async () => {
    const id = await session("umbra", 1, 7);

    const res = await app.fetch(await command(id), discord.env(env));
    const json = (await res.json()) as { type: number; data: { custom_id: string } };

    expect(json.type).toBe(InteractionResponseType.MODAL);
    expect(decodeCustomId(json.data.custom_id)).toMatchObject({
      action: "poll-open",
      target: id,
    });
    expect(await polls()).toEqual([]);
  });

  it("asks for a session when none was named", async () => {
    const res = await app.fetch(await command(), discord.env(env));
    expect(((await res.json()) as { data: { content: string } }).data.content).toContain(
      "Name the session",
    );
  });
});

describe("the submission", () => {
  it("writes the poll, its dates and both jobs", async () => {
    const id = await session("umbra", 1, 7);

    const res = await app.fetch(
      await submit(id, "2026-10-01 19:00\nThu 8 Oct 2026 7pm"),
      discord.env(env),
    );

    expect(((await res.json()) as { data: { content: string } }).data.content).toContain("2 days");

    const [poll] = await polls();
    expect(poll).toMatchObject({
      targetSessionId: id,
      campaignId: "umbra",
      openedBy: "ada",
      status: "open",
      discordChannelId: "chan-1",
    });
    expect(await db(env).select().from(schema.pollDates).all()).toHaveLength(2);
    expect(
      (await db(env).select().from(schema.jobs).all()).map((job) => job.kind).sort(),
    ).toEqual(["poll.close", "poll.post"]);
  });

  it("keeps the session's own length for every candidate date", async () => {
    const id = await session("umbra", 1, 7);
    await app.fetch(await submit(id, "2026-10-01 19:00"), discord.env(env));

    const [date] = await db(env).select().from(schema.pollDates).all();
    expect(date!.endsAt - date!.startsAt).toBe(4 * 3600);
  });

  it("posts it on the next drain", async () => {
    const id = await session("umbra", 1, 7);
    await app.fetch(await submit(id, "2026-10-01 19:00"), discord.env(env));
    calls = [];

    await drainJobs(env);

    expect(calls).toContain("/channels/chan-1/messages");
  });

  it("writes nothing and names every line it could not read", async () => {
    const id = await session("umbra", 1, 7);

    const res = await app.fetch(
      await submit(id, "2026-10-01 19:00\nsometime next week\nwhenever"),
      discord.env(env),
    );

    const content = ((await res.json()) as { data: { content: string } }).data.content;
    // Nobody should retype nine good dates because of one bad one.
    expect(content).toContain("sometime next week");
    expect(content).toContain("whenever");
    expect(await polls()).toEqual([]);
    expect(await db(env).select().from(schema.jobs).all()).toEqual([]);
  });

  it("says so when there are more dates than a poll takes", async () => {
    const id = await session("umbra", 1, 7);
    const lines = Array.from({ length: 11 }, (_, i) => `2026-10-0${(i % 9) + 1} 19:00`);

    const res = await app.fetch(await submit(id, lines.join("\n")), discord.env(env));

    expect(((await res.json()) as { data: { content: string } }).data.content).toContain("11 dates");
    expect(await polls()).toEqual([]);
  });

  it("refuses a second poll on the same session, from the index", async () => {
    const id = await session("umbra", 1, 7);
    await app.fetch(await submit(id, "2026-10-01 19:00"), discord.env(env));

    const res = await app.fetch(await submit(id, "2026-10-08 19:00"), discord.env(env));

    // The check is not "select, then insert" — that races with itself, which is
    // what the partial unique index is there to stop.
    expect(((await res.json()) as { data: { content: string } }).data.content).toContain(
      "already a poll open",
    );
    expect(await polls()).toHaveLength(1);
    expect(await db(env).select().from(schema.pollDates).all()).toHaveLength(1);
  });

  it("allows a new poll once the first has been settled", async () => {
    const id = await session("umbra", 1, 7);
    await app.fetch(await submit(id, "2026-10-01 19:00"), discord.env(env));
    await db(env).update(schema.datePolls).set({ status: "closed" });

    await app.fetch(await submit(id, "2026-10-08 19:00"), discord.env(env));

    expect(await polls()).toHaveLength(2);
  });

  it("says so rather than failing when there is nowhere to post", async () => {
    await db(env)
      .update(schema.campaigns)
      .set({ discordChannelId: null })
      .where(eq(schema.campaigns.id, "umbra"));
    const id = await session("umbra", 1, 7);

    const res = await app.fetch(await submit(id, "2026-10-01 19:00"), discord.env(env));

    expect(((await res.json()) as { data: { content: string } }).data.content).toContain(
      "nowhere to post",
    );
    expect(await polls()).toEqual([]);
  });

  it("degrades to the retired-post response for a session that is gone", async () => {
    const res = await app.fetch(
      await submit("no-such-session", "2026-10-01 19:00"),
      discord.env(env),
    );
    expect(((await res.json()) as { data: { content: string } }).data.content).toContain("retired");
  });
});
