import { env } from "cloudflare:test";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db, schema } from "../src/db/index.ts";
import { SETTING_KEYS, setSetting } from "../src/db/settings.ts";
import { mintId } from "../src/db/ids.ts";
import { decodeCustomId } from "../src/discord/custom-id.ts";
import { drainJobs } from "../src/jobs/drain.ts";
import { find } from "../src/projection/publications.ts";
import {
  POST_SIGNUP_JOB,
  dayThreadName,
  postSignupPost,
  startDayThread,
} from "../src/game-days/post.ts";
import { renderSignupPost, seatButtons } from "../src/game-days/render.ts";
import { capacityOf, claimSeat, signupsForDay } from "../src/game-days/signups.ts";

/**
 * The seating stage's post. Send-only, once, and rendered from D1 — the same
 * three rules the attendance post is built on, applied to a different row.
 */
const realFetch = globalThis.fetch;
const START = Date.parse("2026-11-07T18:00:00Z") / 1000;
const DAY_ID = "day-1";

let calls: { method: string; path: string; body: Record<string, unknown> }[] = [];
let postResponse: () => Response;
let threadResponse: () => Response;

async function day(over: Partial<typeof schema.gameDays.$inferInsert> = {}) {
  await db(env)
    .insert(schema.gameDays)
    .values({
      id: DAY_ID,
      kind: "single",
      gameId: "blades",
      state: "SEATING",
      startsAt: START,
      endsAt: START + 18_000,
      venue: "The Wreck, back room",
      discordChannelId: "chan-1",
      ...over,
    });
  return DAY_ID;
}

async function people(count: number) {
  const ids = Array.from({ length: count }, (_, i) => `p${i}`);
  for (const id of ids) {
    await db(env)
      .insert(schema.users)
      .values({ discordId: id, username: `Player ${id}`, feedToken: `t-${id}` })
      .onConflictDoNothing();
  }
  return ids;
}

function dayRow() {
  return db(env).select().from(schema.gameDays).where(eq(schema.gameDays.id, DAY_ID)).get();
}

/** What `postSignupPost` would render right now, without sending it. */
async function view(asOf = new Date(START * 1000)) {
  const row = await db(env)
    .select({ day: schema.gameDays, game: schema.games })
    .from(schema.gameDays)
    .leftJoin(schema.games, eq(schema.gameDays.gameId, schema.games.id))
    .where(eq(schema.gameDays.id, DAY_ID))
    .get();
  return {
    day: row!.day,
    game: row!.game,
    signups: await signupsForDay(env, DAY_ID),
    capacity: await capacityOf(env, DAY_ID),
    asOf,
  };
}

beforeEach(async () => {
  calls = [];
  postResponse = () => Response.json({ id: "msg-1", channel_id: "chan-1" });
  threadResponse = () => Response.json({ id: "thread-1" });

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    const path = url.pathname.replace("/api/v10", "");
    calls.push({
      method: init?.method ?? "GET",
      path,
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
    });
    if (path.endsWith("/threads")) return threadResponse();
    return postResponse();
  }) as typeof fetch;

  for (const table of [
    "publications",
    "signups",
    "jobs",
    "sessions",
    "poll_dates",
    "date_polls",
    "game_days",
    "campaigns",
    "games",
    "users",
    "settings",
  ]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  await setSetting(env, SETTING_KEYS.guildId, "g1");
  await db(env)
    .insert(schema.games)
    .values({ id: "blades", name: "Blades in the Dark", maxPlayers: 4 });
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("what it says", () => {
  it("names the game, the time, the venue and the room left", async () => {
    await day();
    const ids = await people(2);
    for (const id of ids) await claimSeat(env, DAY_ID, id);

    const { content } = renderSignupPost(await view());

    expect(content).toContain("**Blades in the Dark**");
    expect(content).toContain(`<t:${START}:F>`);
    expect(content).toContain("The Wreck, back room");
    expect(content).toContain("**Seated (2/4)**");
    expect(content).toContain("2 seats left.");
  });

  it("takes the day's capacity over the game's", async () => {
    await day({ capacity: 2 });
    const ids = await people(1);
    await claimSeat(env, DAY_ID, ids[0]!);

    expect(renderSignupPost(await view()).content).toContain("**Seated (1/2)**");
  });

  it("counts down to one seat, then says it is full", async () => {
    await day({ capacity: 2 });
    const ids = await people(2);

    await claimSeat(env, DAY_ID, ids[0]!);
    expect(renderSignupPost(await view()).content).toContain("One seat left.");

    await claimSeat(env, DAY_ID, ids[1]!);
    const full = renderSignupPost(await view()).content;
    expect(full).toContain("Full.");
    expect(full).toContain("waitlist");
  });

  it("says what a day with no number has instead of inventing one", async () => {
    await day({ kind: "multi", gameId: null, title: "November Games Day" });

    const { content } = renderSignupPost(await view());
    expect(content).toContain("**November Games Day**");
    expect(content).toContain("Room for however many turn up.");
    expect(content).not.toMatch(/Seated \(\d+\/\d+\)/);
  });

  it("lists the waitlist behind the seated, in arrival order", async () => {
    await day({ capacity: 1 });
    const ids = await people(3);
    for (const id of ids) await claimSeat(env, DAY_ID, id);

    const { content } = renderSignupPost(await view());
    expect(content).toContain("**Seated (1/1)** — Player p0");
    expect(content).toContain("**Waitlist (2)** — Player p1, Player p2");
  });

  it("says nobody has yet, rather than showing an empty list", async () => {
    await day();
    expect(renderSignupPost(await view()).content).toContain("Nobody has taken a seat yet.");
  });

  it("shows a character name beside whoever gave one", async () => {
    await day();
    const ids = await people(1);
    await claimSeat(env, DAY_ID, ids[0]!, { characterName: "Arquebus" });

    expect(renderSignupPost(await view()).content).toContain("Player p0 (Arquebus)");
  });

  it("mentions nobody at all", async () => {
    await day();
    // A game day is open to the room, so there is no role to ping — and
    // `parse: []` turns off the ones Orrey never means to fire.
    expect(renderSignupPost(await view()).allowed_mentions).toEqual({ parse: [], roles: [] });
  });

  it("stays under Discord's ceiling however many turn up", async () => {
    await day({ kind: "multi", gameId: null, title: "November Games Day" });
    const ids = await people(120);
    for (const id of ids) await claimSeat(env, DAY_ID, id, { characterName: "A character with a long name" });

    const { content } = renderSignupPost(await view());
    expect(content.length).toBeLessThanOrEqual(2000);
    // The line that answers the question survives every truncation pass.
    expect(content).toContain("Room for however many turn up.");
  });
});

describe("the buttons", () => {
  it("are four, in one row, and round-trip through decodeCustomId", async () => {
    const row = seatButtons(DAY_ID) as { components: { label: string; custom_id: string }[] };

    expect(row.components.map((button) => button.label)).toEqual([
      "Take a seat",
      "Waitlist",
      "Out",
      "Refresh",
    ]);
    for (const button of row.components) {
      expect(decodeCustomId(button.custom_id)).toMatchObject({ action: "seat", target: DAY_ID });
    }
  });

  it("carry an id short enough for Discord", () => {
    const row = seatButtons(mintId()) as { components: { custom_id: string }[] };
    for (const button of row.components) expect(button.custom_id.length).toBeLessThanOrEqual(100);
  });
});

describe("sending it", () => {
  it("posts into the day's channel and records the id", async () => {
    await day();

    expect(await postSignupPost(env, DAY_ID)).toBe("msg-1");
    expect(calls).toMatchObject([{ method: "POST", path: "/channels/chan-1/messages" }]);
    expect(await dayRow()).toMatchObject({ discordMessageId: "msg-1" });
    expect(
      await find(env, { surface: "discord", kind: "message", targetId: DAY_ID }),
    ).toMatchObject({ state: "published", remoteId: "msg-1" });
  });

  it("falls back to the scheduling channel when the day has none", async () => {
    await day({ discordChannelId: null });
    await setSetting(env, SETTING_KEYS.schedulingChannelId, "chan-fallback");

    await postSignupPost(env, DAY_ID);

    expect(calls[0]?.path).toBe("/channels/chan-fallback/messages");
    // And the channel it actually went to is recorded, so the thread hangs off
    // the right message rather than off a setting somebody changed since.
    expect(await dayRow()).toMatchObject({ discordChannelId: "chan-fallback" });
  });

  it("does not post a second one", async () => {
    await day();
    await postSignupPost(env, DAY_ID);
    calls = [];

    expect(await postSignupPost(env, DAY_ID)).toBe("msg-1");
    expect(calls).toEqual([]);
  });

  it("heals from the ledger when only the game_days write was lost", async () => {
    await day();
    await postSignupPost(env, DAY_ID);
    await env.DB.prepare("UPDATE game_days SET discord_message_id = NULL").run();
    calls = [];

    expect(await postSignupPost(env, DAY_ID)).toBe("msg-1");
    expect(calls).toEqual([]);
    expect(await dayRow()).toMatchObject({ discordMessageId: "msg-1" });
  });

  it("lets the next attempt post when Discord refused this one", async () => {
    await day();
    postResponse = () => Response.json({ code: 50001, message: "Missing Access" }, { status: 403 });

    await expect(postSignupPost(env, DAY_ID)).rejects.toThrow();
    expect(await find(env, { surface: "discord", kind: "message", targetId: DAY_ID })).toBeUndefined();

    postResponse = () => Response.json({ id: "msg-later", channel_id: "chan-1" });
    expect(await postSignupPost(env, DAY_ID)).toBe("msg-later");
  });

  it("holds the claim when it never heard back", async () => {
    await day();
    postResponse = () => {
      throw new TypeError("network error");
    };

    await expect(postSignupPost(env, DAY_ID)).rejects.toThrow();

    // Not hearing a clear no is not the same as it not having happened, and a
    // second post with live buttons is the one thing send-only cannot undo.
    expect(await find(env, { surface: "discord", kind: "message", targetId: DAY_ID })).toMatchObject(
      { state: "claimed", remoteId: null },
    );
  });

  it("does nothing for a day that is not there", async () => {
    expect(await postSignupPost(env, "no-such-day")).toBeUndefined();
    expect(calls).toEqual([]);
  });
});

describe("the thread", () => {
  it("hangs off the post and is named after the day", async () => {
    await day();
    await postSignupPost(env, DAY_ID);
    calls = [];

    expect(await startDayThread(env, DAY_ID)).toBe("thread-1");
    expect(calls).toMatchObject([
      { method: "POST", path: "/channels/chan-1/messages/msg-1/threads" },
    ]);
    expect(calls[0]?.body).toMatchObject({
      name: "Blades in the Dark — 7 November",
      auto_archive_duration: 10_080,
    });
    expect(await dayRow()).toMatchObject({ threadId: "thread-1" });
  });

  it("makes none for a day that was never posted", async () => {
    await day();
    expect(await startDayThread(env, DAY_ID)).toBeUndefined();
    expect(calls).toEqual([]);
  });

  it("does nothing a second time", async () => {
    await day();
    await postSignupPost(env, DAY_ID);
    await startDayThread(env, DAY_ID);
    calls = [];

    expect(await startDayThread(env, DAY_ID)).toBe("thread-1");
    expect(calls).toEqual([]);
  });

  it("stops asking once Discord says the message already has one", async () => {
    await day();
    await postSignupPost(env, DAY_ID);
    threadResponse = () =>
      Response.json({ code: 160004, message: "A thread has already been created" }, { status: 400 });

    expect(await startDayThread(env, DAY_ID)).toBeUndefined();
  });

  it("names it in the guild's day, not the server's", async () => {
    const row = { ...(await day().then(dayRow))! };
    // 23:30 UTC on 7 November is already the 8th in Auckland. A thread name is
    // plain text, so this is one of the few places Orrey has to pick a zone.
    row.startsAt = Date.parse("2026-11-07T23:30:00Z") / 1000;
    const game = { name: "Blades in the Dark" } as typeof schema.games.$inferSelect;

    expect(dayThreadName(row, game, "Pacific/Auckland")).toContain("8 November");
    expect(dayThreadName(row, game, "America/New_York")).toContain("7 November");
  });
});

describe("the job", () => {
  it("posts and then starts the thread, in that order", async () => {
    await day();
    await db(env)
      .insert(schema.jobs)
      .values({
        id: `${POST_SIGNUP_JOB}:${DAY_ID}`,
        kind: POST_SIGNUP_JOB,
        payload: { gameDayId: DAY_ID },
        idempotencyKey: `${POST_SIGNUP_JOB}:${DAY_ID}`,
        runAt: sql`(unixepoch())`,
      });

    await drainJobs(env);

    expect(calls.map((call) => call.path)).toEqual([
      "/channels/chan-1/messages",
      "/channels/chan-1/messages/msg-1/threads",
    ]);
    expect(await dayRow()).toMatchObject({
      discordMessageId: "msg-1",
      threadId: "thread-1",
    });
  });
});
