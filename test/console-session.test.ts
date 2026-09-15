import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db, schema } from "../src/db/index.ts";
import { SETTING_KEYS, setSetting } from "../src/db/settings.ts";
import { createApp } from "../src/http/app.ts";
import { SESSION_COOKIE, issueSession } from "../src/console/cookies.ts";
import { InteractionResponseType, InteractionType } from "../src/discord/types.ts";
import { encodeCustomId } from "../src/discord/custom-id.ts";
import { fakeDiscord } from "./discord.ts";
import { sessionDetail, syncStateOf } from "../src/console/session-detail.ts";

/**
 * The session rail. Read-only, and the thing worth testing is what it says when
 * a projection has not happened, has failed, or has lost its id — because all
 * three are ordinary states and none of them is an error.
 */
const app = createApp();
const discord = await fakeDiscord();
const realFetch = globalThis.fetch;
const NOW = new Date("2026-11-01T12:00:00Z");
const START = Math.floor(NOW.getTime() / 1000) + 86_400;
const ORGANISER_ROLE = "role-organiser";

function consoleEnv() {
  return {
    ...env,
    CONSOLE_SESSION_SECRET: "a-secret",
    DISCORD_APPLICATION_ID: "app-1",
    DISCORD_CLIENT_SECRET: "shh",
    DISCORD_BOT_TOKEN: "bot-token",
  };
}

async function get(path: string) {
  return app.fetch(
    new Request(`https://orrey.test${path}`, {
      headers: { cookie: `${SESSION_COOKIE}=${await issueSession(consoleEnv(), "1001", new Date())}` },
    }),
    consoleEnv(),
  );
}

async function person(id: string) {
  await db(env)
    .insert(schema.users)
    .values({ discordId: id, username: id, globalName: `Player ${id}`, feedToken: `t-${id}` })
    .onConflictDoNothing();
}

async function seed(over: Partial<typeof schema.sessions.$inferInsert> = {}) {
  await db(env)
    .insert(schema.campaigns)
    .values({ id: "umbra", name: "Age of Umbra", kind: "run", state: "RUNNING", quorum: 2 });
  for (const who of ["a", "b", "c"]) {
    await person(who);
    await db(env).insert(schema.campaignMembers).values({ campaignId: "umbra", userId: who });
  }
  await db(env)
    .insert(schema.sessions)
    .values({
      id: "s",
      kind: "campaign_session",
      campaignId: "umbra",
      number: 1,
      startsAt: START,
      endsAt: START + 4 * 3600,
      location: "The Wreck",
      ...over,
    });
  return "s";
}

beforeEach(async () => {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("/members/")) return Response.json({ roles: [ORGANISER_ROLE] });
    return new Response("unexpected", { status: 500 });
  }) as typeof fetch;

  for (const table of [
    "calendar_links",
    "attendance",
    "campaign_members",
    "sessions",
    "campaigns",
    "discord_tokens",
    "users",
    "settings",
  ]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  await setSetting(env, SETTING_KEYS.guildId, "g1");
  await setSetting(env, SETTING_KEYS.organiserRoleId, ORGANISER_ROLE);
  await person("1001");
  await db(env)
    .insert(schema.discordTokens)
    .values({ userId: "1001", accessToken: "at", refreshToken: "rt", expiresAt: START });
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("the roster", () => {
  it("shows no reply as its own answer, never as out", async () => {
    await seed();
    await db(env).insert(schema.attendance).values({ sessionId: "s", userId: "a", intent: "in" });

    const detail = (await sessionDetail(env, "s"))!;
    expect(detail.roster).toMatchObject([
      { userId: "a", intent: "in", attended: null },
      { userId: "b", intent: null, attended: null },
      { userId: "c", intent: null, attended: null },
    ]);
  });

  it("shows attended as null until the register is written", async () => {
    await seed();
    await db(env).insert(schema.attendance).values({ sessionId: "s", userId: "a", intent: "in" });

    // "Did not come" and "nobody has written the register yet" are different
    // answers, and the rail shows them differently.
    expect((await sessionDetail(env, "s"))!.roster[0]?.attended).toBeNull();
  });

  it("says when a person decided it rather than Orrey guessing", async () => {
    await seed();
    await db(env)
      .insert(schema.attendance)
      .values({ sessionId: "s", userId: "a", intent: "in", attended: 1, attendedSource: "auto" });
    await db(env)
      .insert(schema.attendance)
      .values({ sessionId: "s", userId: "b", intent: "in", attended: 0, attendedSource: "gm" });

    const { roster } = (await sessionDetail(env, "s"))!;
    expect(roster.find((row) => row.userId === "a")).toMatchObject({
      attended: true,
      corrected: false,
    });
    expect(roster.find((row) => row.userId === "b")).toMatchObject({
      attended: false,
      corrected: true,
    });
  });
});

describe("the projection state", () => {
  it("reads as not projected when there is no link row", async () => {
    await seed();
    expect((await sessionDetail(env, "s"))!.sync).toEqual({
      state: "not-projected",
      syncedAt: null,
      lastError: null,
    });
  });

  it("reads as failing when last_error is set", async () => {
    await seed();
    await db(env)
      .insert(schema.calendarLinks)
      .values({ sessionId: "s", gcalEventId: "g1", syncedAt: START - 3600, lastError: "boom" });

    expect((await sessionDetail(env, "s"))!.sync).toMatchObject({
      state: "failing",
      lastError: "boom",
    });
  });

  it("reads as synced otherwise, with the timestamp the row says", async () => {
    await seed();
    await db(env)
      .insert(schema.calendarLinks)
      .values({ sessionId: "s", gcalEventId: "g1", syncedAt: START - 60 });

    expect((await sessionDetail(env, "s"))!.sync).toEqual({
      state: "synced",
      syncedAt: START - 60,
      lastError: null,
    });
  });

  it("is a pure reading of the row", () => {
    expect(syncStateOf(undefined).state).toBe("not-projected");
    expect(syncStateOf({ syncedAt: 1, lastError: null }).state).toBe("synced");
    expect(syncStateOf({ syncedAt: 1, lastError: "x" }).state).toBe("failing");
  });
});

describe("the links", () => {
  it("assembles them from ids and calls nothing", async () => {
    await seed({ threadId: "thread-1", discordEventId: "event-1" });

    const detail = (await sessionDetail(env, "s"))!;
    expect(detail.threadUrl).toBe("https://discord.com/channels/g1/thread-1");
    expect(detail.eventUrl).toBe("https://discord.com/events/g1/event-1");
  });

  it("has no event link when the id has gone, which is not a failure", async () => {
    await seed({ threadId: "thread-1" });

    // A lapsed Discord event is replaced rather than revived, so the id going
    // missing is the system working. Nothing dresses it up as an error.
    const detail = (await sessionDetail(env, "s"))!;
    expect(detail.eventUrl).toBeNull();
    expect(detail.sync.state).toBe("not-projected");
  });

  it("has neither when the guild id has never been seeded", async () => {
    await env.DB.prepare("DELETE FROM settings WHERE key = ?").bind(SETTING_KEYS.guildId).run();
    await seed({ threadId: "thread-1", discordEventId: "event-1" });

    const detail = (await sessionDetail(env, "s"))!;
    expect(detail.threadUrl).toBeNull();
    expect(detail.eventUrl).toBeNull();
  });
});

describe("the route", () => {
  it("answers the detail", async () => {
    await seed();
    const res = await get("/api/sessions/s");

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ sessionId: "s", title: "Age of Umbra — Session 1" });
  });

  it("answers 404 for a session that is not there", async () => {
    expect((await get("/api/sessions/nowhere")).status).toBe(404);
  });

  it("is behind the same gate as everything else", async () => {
    await seed();
    const res = await app.fetch(
      new Request("https://orrey.test/api/sessions/s"),
      consoleEnv(),
    );
    expect(res.status).toBe(401);
  });
});

describe("the three writes", () => {
  let calls: { path: string; body: Record<string, unknown> }[] = [];

  async function post(path: string, body: unknown = {}) {
    return app.fetch(
      new Request(`https://orrey.test${path}`, {
        method: "POST",
        headers: {
          cookie: `${SESSION_COOKIE}=${await issueSession(consoleEnv(), "1001", NOW)}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      }),
      consoleEnv(),
    );
  }

  function audit() {
    return db(env).select().from(schema.auditLog).all();
  }

  beforeEach(async () => {
    calls = [];
    await env.DB.prepare("DELETE FROM audit_log").run();
    await env.DB.prepare("DELETE FROM publications").run();
    await env.DB.prepare("DELETE FROM date_polls").run();
    await env.DB.prepare("DELETE FROM poll_dates").run();

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      );
      if (url.pathname.includes("/members/")) return Response.json({ roles: [ORGANISER_ROLE] });
      calls.push({
        path: url.pathname.replace("/api/v10", ""),
        body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
      });
      return Response.json({ id: "msg-1", channel_id: "chan-1" });
    }) as typeof fetch;
  });

  it("locks, and writes exactly one audit row", async () => {
    await seed();

    expect((await post("/api/sessions/s/lock")).status).toBe(200);

    expect(
      await db(env).select().from(schema.sessions).where(eq(schema.sessions.id, "s")).get(),
    ).toMatchObject({ state: "LOCKED" });
    expect(await audit()).toMatchObject([
      { actorUserId: "1001", action: "session.lock", targetId: "s" },
    ]);
  });

  it("refuses an intent change once locked, and does not touch the post", async () => {
    await seed();
    await post("/api/sessions/s/lock");

    const res = await app.fetch(
      await discord.request({
        type: InteractionType.MESSAGE_COMPONENT,
        data: {
          custom_id: encodeCustomId({ action: "attend", arg: "in", target: "s" }),
          component_type: 2,
        },
        member: { user: { id: "a", username: "a", global_name: null }, roles: [] },
        message: { id: "msg-1", channel_id: "chan-1" },
      }),
      discord.env(env),
    );
    const answer = (await res.json()) as { type: number; data: { content: string } };

    // Ephemeral, and the post is left as it was: rewriting it would make a stale
    // reading look fresh, and Orrey cannot edit it back.
    expect(answer.type).toBe(InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE);
    expect(answer.data.content).toContain("settled");
    expect(await db(env).select().from(schema.attendance).all()).toEqual([]);
  });

  it("still lets somebody refresh a locked session's post", async () => {
    await seed();
    await post("/api/sessions/s/lock");

    const res = await app.fetch(
      await discord.request({
        type: InteractionType.MESSAGE_COMPONENT,
        data: {
          custom_id: encodeCustomId({ action: "attend", arg: "refresh", target: "s" }),
          component_type: 2,
        },
        member: { user: { id: "a", username: "a", global_name: null }, roles: [] },
        message: { id: "msg-1", channel_id: "chan-1" },
      }),
      discord.env(env),
    );
    expect(((await res.json()) as { type: number }).type).toBe(
      InteractionResponseType.UPDATE_MESSAGE,
    );
  });

  it("cancels: one audit row, one notice, both deletes, and no edit", async () => {
    await seed({ threadId: "thread-1" });

    expect((await post("/api/sessions/s/cancel")).status).toBe(200);

    expect(
      await db(env).select().from(schema.sessions).where(eq(schema.sessions.id, "s")).get(),
    ).toMatchObject({ state: "CANCELLED" });
    expect(await audit()).toMatchObject([{ action: "session.cancel", actorUserId: "1001" }]);

    // A new message in the thread, never an edit of the attendance post.
    const posts = calls.filter((call) => call.path === "/channels/thread-1/messages");
    expect(posts).toHaveLength(1);
    expect(posts[0]?.body.content).toContain("It's off.");
    expect(calls.some((call) => call.path.match(/\/messages\/[^/]+$/))).toBe(false);
  });

  it("cancels once, however often it is asked", async () => {
    await seed({ threadId: "thread-1" });
    await post("/api/sessions/s/cancel");
    calls = [];

    const again = await post("/api/sessions/s/cancel");

    expect(((await again.json()) as { outcome: string }).outcome).toBe("already");
    expect(calls.filter((call) => call.path.includes("/messages"))).toEqual([]);
    expect(await audit()).toHaveLength(1);
  });

  it("refuses to lock or cancel a session that has been played", async () => {
    await seed({ state: "PLAYED" });

    expect((await post("/api/sessions/s/lock")).status).toBe(400);
    expect((await post("/api/sessions/s/cancel")).status).toBe(400);
    expect(await audit()).toEqual([]);
  });

  it("opens a targeted poll through the same path the bot uses", async () => {
    await seed();
    await setSetting(env, SETTING_KEYS.schedulingChannelId, "chan-1");

    const res = await post("/api/sessions/s/poll", { dates: "2027-01-09 19:00" });

    expect(res.status).toBe(201);
    expect(await db(env).select().from(schema.datePolls).all()).toMatchObject([
      { targetSessionId: "s", openedBy: "1001" },
    ]);
  });

  it("refuses a second poll with the sentence the bot gives", async () => {
    await seed();
    await setSetting(env, SETTING_KEYS.schedulingChannelId, "chan-1");
    await post("/api/sessions/s/poll", { dates: "2027-01-09 19:00" });

    const res = await post("/api/sessions/s/poll", { dates: "2027-01-16 19:00" });

    expect(res.status).toBe(409);
    expect((await res.json()) as { error: string }).toMatchObject({
      error: "there is already a poll open for that",
    });
  });

  it("gives a non-organiser 403, and writes nothing anywhere", async () => {
    await seed();
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/members/")) return Response.json({ roles: [] });
      return new Response("unexpected", { status: 500 });
    }) as typeof fetch;

    expect((await post("/api/sessions/s/cancel")).status).toBe(403);
    expect(await audit()).toEqual([]);
    expect(
      await db(env).select().from(schema.sessions).where(eq(schema.sessions.id, "s")).get(),
    ).toMatchObject({ state: "SCHEDULED" });
  });
});
