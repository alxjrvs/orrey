import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db, schema } from "../src/db/index.ts";
import { SETTING_KEYS, setSetting } from "../src/db/settings.ts";
import { createApp } from "../src/http/app.ts";
import { decodeCustomId, encodeCustomId } from "../src/discord/custom-id.ts";
import { InteractionResponseType, InteractionType, MessageFlags } from "../src/discord/types.ts";
import { correctionPost } from "../src/attendance/render.ts";
import { registerRows } from "../src/attendance/assume.ts";
import { loadProjectionTarget } from "../src/projection/target.ts";
import { sessionLogs } from "../src/logs/session-log.ts";
import { fakeDiscord } from "./discord.ts";

/**
 * The first of the recap's two doors.
 *
 * A recap is appended and never replaced, which is what makes this modal
 * different from the note modal in every way that matters: it is not prefilled,
 * an empty box writes nothing rather than clearing something, and submitting
 * twice is two recaps. The post it was launched from is never rewritten.
 */
const discord = await fakeDiscord();
const app = createApp();
const realFetch = globalThis.fetch;
const START = Math.floor(Date.parse("2026-09-20T18:00:00Z") / 1000);
const SESSION_ID = "umbra-s12";
const GM = "gm-1";
const PLAYER = "p-1";

let posts: { path: string; body: Record<string, unknown> }[] = [];

async function seed() {
  await db(env)
    .insert(schema.campaigns)
    .values({
      id: "umbra",
      name: "Age of Umbra",
      kind: "run",
      state: "RUNNING",
      discordChannelId: "chan-1",
    });
  for (const [id, role] of [
    [GM, "gm"],
    [PLAYER, "player"],
  ] as const) {
    await db(env)
      .insert(schema.users)
      .values({ discordId: id, username: id, feedToken: `t-${id}` })
      .onConflictDoNothing();
    await db(env).insert(schema.campaignMembers).values({ campaignId: "umbra", userId: id, role });
  }
  await db(env)
    .insert(schema.sessions)
    .values({
      id: SESSION_ID,
      kind: "campaign_session",
      campaignId: "umbra",
      number: 12,
      startsAt: START,
      endsAt: START + 4 * 3600,
      state: "PLAYED",
      threadId: "thread-1",
    });
}

function click(userId: string) {
  return discord.request({
    type: InteractionType.MESSAGE_COMPONENT,
    data: { custom_id: encodeCustomId({ action: "recap", target: SESSION_ID }), component_type: 2 },
    member: { user: { id: userId, username: userId }, roles: [] },
    message: { id: "msg-1", channel_id: "chan-1" },
  });
}

function submit(userId: string, value: string, target = SESSION_ID) {
  return discord.request({
    type: InteractionType.MODAL_SUBMIT,
    data: {
      custom_id: encodeCustomId({ action: "recap-body", target }),
      components: [{ components: [{ custom_id: "recap", value }] }],
    },
    member: { user: { id: userId, username: userId }, roles: [] },
    message: { id: "msg-1", channel_id: "chan-1" },
  });
}

async function send(request: Request) {
  const res = await app.fetch(request, discord.env(env));
  expect(res.status).toBe(200);
  return (await res.json()) as { type: number; data: Record<string, unknown> };
}

beforeEach(async () => {
  posts = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    posts.push({
      path: url.pathname.replace("/api/v10", ""),
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
    });
    return Response.json({ id: `msg-${posts.length}`, channel_id: "chan-1" });
  }) as typeof fetch;

  for (const table of [
    "session_logs",
    "attendance",
    "campaign_members",
    "sessions",
    "campaigns",
    "game_days",
    "users",
    "settings",
  ]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  await setSetting(env, SETTING_KEYS.guildId, "g1");
  await seed();
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("the button and the modal", () => {
  it("is on the correction post, under the toggles", async () => {
    const target = (await loadProjectionTarget(env, SESSION_ID))!;
    const post = correctionPost(target, await registerRows(env, SESSION_ID), new Date());

    const rows = post.components as { components: { custom_id: string }[] }[];
    const last = rows.at(-1)!.components;
    expect(decodeCustomId(last.at(-1)!.custom_id)?.action).toBe("recap");
  });

  it("opens a modal that is not prefilled", async () => {
    const answer = await send(await click(GM));

    expect(answer.type).toBe(InteractionResponseType.MODAL);
    const input = (
      answer.data.components as { components: Record<string, unknown>[] }[]
    )[0]!.components[0]!;
    // A note is prefilled because an empty box there means "clear it". A recap
    // is appended and never replaced, so an empty box means nothing was written
    // and there is nothing to clear.
    expect(input).not.toHaveProperty("value");
    expect(input).toMatchObject({ custom_id: "recap", required: false });
  });

  it("refuses somebody who did not run it, before they type anything", async () => {
    const answer = await send(await click(PLAYER));

    expect(answer.type).toBe(InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE);
    expect(answer.data.flags).toBe(MessageFlags.EPHEMERAL);
    expect(answer.data.content).toContain("Only whoever ran it");
  });

  it("degrades a click on a post whose session is gone", async () => {
    await env.DB.prepare("DELETE FROM sessions").run();
    const answer = await send(await click(GM));
    expect(answer.data.content).toContain("no longer");
  });
});

describe("submitting one", () => {
  it("stores the row and posts a new message in the thread", async () => {
    const answer = await send(await submit(GM, "They took the Wreck.\n\nThen the tide came in."));

    expect(answer.data.flags).toBe(MessageFlags.EPHEMERAL);
    const logs = await sessionLogs(env, SESSION_ID);
    expect(logs).toHaveLength(1);
    // Newlines survive: a recap is a message of its own, not a note rendered
    // inline on a post.
    expect(logs[0]?.body).toBe("They took the Wreck.\n\nThen the tide came in.");
    expect(logs[0]?.author).toBe(GM);

    expect(posts).toMatchObject([{ path: "/channels/thread-1/messages" }]);
    expect(posts[0]?.body).toMatchObject({
      content: expect.stringContaining("They took the Wreck."),
      allowed_mentions: { parse: [], roles: [] },
    });
  });

  it("never rewrites the post it was launched from", async () => {
    const answer = await send(await submit(GM, "a recap"));

    // The correction post's toggles are everybody else's to use. An
    // UPDATE_MESSAGE here would replace them with one person's confirmation,
    // permanently, because the post is never edited again.
    expect(answer.type).toBe(InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE);
    expect(answer.type).not.toBe(InteractionResponseType.UPDATE_MESSAGE);
  });

  it("appends, so submitting twice is two recaps", async () => {
    await send(await submit(GM, "first"));
    await send(await submit(GM, "second"));

    expect((await sessionLogs(env, SESSION_ID)).map((row) => row.body)).toEqual([
      "first",
      "second",
    ]);
  });

  it("writes nothing and posts nothing for an empty box", async () => {
    const answer = await send(await submit(GM, "   \n\n "));

    expect(answer.data.content).toContain("Nothing in the box");
    expect(await sessionLogs(env, SESSION_ID)).toEqual([]);
    expect(posts).toEqual([]);
  });

  it("refuses somebody who did not run it, and writes nothing", async () => {
    const answer = await send(await submit(PLAYER, "I was there too"));

    // Asked again on submit: a permission checked only at the first step of a
    // multi-step interaction is a permission not checked at all.
    expect(answer.data.content).toContain("Only whoever ran it");
    expect(await sessionLogs(env, SESSION_ID)).toEqual([]);
    expect(posts).toEqual([]);
  });

  it("escapes what somebody wrote", async () => {
    await send(await submit(GM, "**not bold** and `not code`"));

    // Somebody else's free text on a post Orrey can never edit. A stray
    // backtick would break that post's layout permanently.
    expect(posts[0]?.body).toMatchObject({
      content: expect.stringContaining("\\*\\*not bold\\*\\*"),
    });
  });

  it("falls back to the campaign channel for a session with no thread", async () => {
    await db(env)
      .update(schema.sessions)
      .set({ threadId: null })
      .where(eq(schema.sessions.id, SESSION_ID));

    await send(await submit(GM, "a recap"));

    expect(posts).toMatchObject([{ path: "/channels/chan-1/messages" }]);
  });

  it("degrades a submit whose session is gone", async () => {
    await env.DB.prepare("DELETE FROM sessions").run();
    const answer = await send(await submit(GM, "a recap"));
    expect(answer.data.content).toContain("no longer");
  });
});

describe("a game day's recap", () => {
  it("is whoever ran the day, not a campaign GM", async () => {
    await db(env)
      .insert(schema.gameDays)
      .values({
        id: "day-1",
        kind: "single",
        state: "PLAYED",
        startsAt: START,
        endsAt: START + 4 * 3600,
        hostUserId: PLAYER,
      });
    await db(env)
      .insert(schema.sessions)
      .values({
        id: "gd-day-1",
        kind: "one_off",
        gameDayId: "day-1",
        startsAt: START,
        endsAt: START + 4 * 3600,
        state: "PLAYED",
      });

    // The host of the day may; the GM of an unrelated campaign may not.
    expect((await send(await submit(PLAYER, "we played", "gd-day-1"))).data.content).toContain(
      "posted in the thread",
    );
    expect((await send(await submit(GM, "no I did", "gd-day-1"))).data.content).toContain(
      "Only whoever ran it",
    );
    expect((await sessionLogs(env, "gd-day-1")).map((row) => row.body)).toEqual(["we played"]);
  });

  it("says so when nobody is down as running it", async () => {
    await db(env)
      .insert(schema.gameDays)
      .values({
        id: "day-2",
        kind: "single",
        state: "PLAYED",
        startsAt: START,
        endsAt: START + 4 * 3600,
      });
    await db(env)
      .insert(schema.sessions)
      .values({
        id: "gd-day-2",
        kind: "one_off",
        gameDayId: "day-2",
        startsAt: START,
        endsAt: START + 4 * 3600,
        state: "PLAYED",
      });

    // Fails closed, and says which way — a fixable answer rather than a silent
    // refusal or an open door.
    expect((await send(await submit(PLAYER, "we played", "gd-day-2"))).data.content).toContain(
      "set a host in the console",
    );
  });
});
