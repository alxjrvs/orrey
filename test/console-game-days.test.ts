import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db, schema } from "../src/db/index.ts";
import { SETTING_KEYS, setSetting } from "../src/db/settings.ts";
import { createApp } from "../src/http/app.ts";
import { SESSION_COOKIE, issueSession } from "../src/console/cookies.ts";
import { sessionIdFor } from "../src/game-days/lifecycle.ts";

/**
 * Opening seating is a console page, not a fifth command.
 *
 * The route is a caller: everything that decides what opening seating means
 * lives in `src/game-days/lifecycle.ts`, and this reads a state and hands over.
 */
const app = createApp();
const realFetch = globalThis.fetch;
const NOW = new Date("2026-09-14T12:00:00Z");
const START = Date.parse("2026-11-07T18:00:00Z") / 1000;
const ORGANISER_ROLE = "role-organiser";
const DAY_ID = "day-1";

let roles = [ORGANISER_ROLE];

function consoleEnv() {
  return {
    ...env,
    CONSOLE_SESSION_SECRET: "a-secret",
    DISCORD_APPLICATION_ID: "app-1",
    DISCORD_CLIENT_SECRET: "shh",
    DISCORD_BOT_TOKEN: "bot-token",
  };
}

async function send(method: string, path: string, body?: unknown) {
  return app.fetch(
    new Request(`https://orrey.test${path}`, {
      method,
      headers: {
        cookie: `${SESSION_COOKIE}=${await issueSession(consoleEnv(), "1001", NOW)}`,
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    consoleEnv(),
  );
}

async function day(over: Partial<typeof schema.gameDays.$inferInsert> = {}) {
  await db(env)
    .insert(schema.gameDays)
    .values({
      id: DAY_ID,
      kind: "single",
      gameId: "blades",
      startsAt: START,
      endsAt: START + 18_000,
      venue: "The Wreck",
      ...over,
    });
}

function dayRow() {
  return db(env).select().from(schema.gameDays).where(eq(schema.gameDays.id, DAY_ID)).get();
}

beforeEach(async () => {
  roles = [ORGANISER_ROLE];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("/members/")) return Response.json({ roles });
    return new Response("unexpected", { status: 500 });
  }) as typeof fetch;

  for (const table of [
    "audit_log",
    "signups",
    "jobs",
    "sessions",
    "game_days",
    "campaigns",
    "games",
    "discord_tokens",
    "users",
    "settings",
  ]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  await setSetting(env, SETTING_KEYS.guildId, "g1");
  await setSetting(env, SETTING_KEYS.organiserRoleId, ORGANISER_ROLE);
  await db(env).insert(schema.users).values({ discordId: "1001", username: "ada", feedToken: "t" });
  await db(env)
    .insert(schema.discordTokens)
    .values({
      userId: "1001",
      accessToken: "at",
      refreshToken: "rt",
      expiresAt: Math.floor(NOW.getTime() / 1000) + 86_400,
    });
  await db(env)
    .insert(schema.games)
    .values({ id: "blades", name: "Blades in the Dark", minPlayers: 3, maxPlayers: 4 });
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("the read half", () => {
  it("shows a day with its seats counted from D1", async () => {
    await day({ state: "SEATING", capacity: 2 });
    for (const id of ["p0", "p1", "p2"]) {
      await db(env)
        .insert(schema.users)
        .values({ discordId: id, username: id, feedToken: `t-${id}` });
    }
    await db(env)
      .insert(schema.signups)
      .values([
        { targetType: "game_day", targetId: DAY_ID, userId: "p0", state: "in", position: 1 },
        { targetType: "game_day", targetId: DAY_ID, userId: "p1", state: "in", position: 2 },
        {
          targetType: "game_day",
          targetId: DAY_ID,
          userId: "p2",
          state: "waitlisted",
          position: 3,
        },
      ]);

    const body = (await (await send("GET", "/api/game-days")).json()) as {
      gameDays: Record<string, unknown>[];
    };

    // Counted here, never read off the post — the post is a projection and may
    // be an hour stale.
    expect(body.gameDays).toMatchObject([
      {
        id: DAY_ID,
        state: "SEATING",
        gameName: "Blades in the Dark",
        capacity: 2,
        seated: 2,
        waitlisted: 1,
      },
    ]);
  });

  it("takes the capacity from the game when the day says nothing", async () => {
    await day();
    const body = (await (await send("GET", "/api/game-days")).json()) as {
      gameDays: { capacity: number }[];
    };
    expect(body.gameDays[0]?.capacity).toBe(4);
  });
});

describe("opening seating", () => {
  it("moves the day and mints its session", async () => {
    await day();

    const response = await send("POST", `/api/game-days/${DAY_ID}/transition`, { to: "SEATING" });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      from: "PROPOSED",
      to: "SEATING",
      sessionId: sessionIdFor(DAY_ID),
    });
    expect(await dayRow()).toMatchObject({ state: "SEATING" });
  });

  it("leaves the organiser's name on it", async () => {
    await day();
    await send("POST", `/api/game-days/${DAY_ID}/transition`, { to: "SEATING" });

    expect(await db(env).select().from(schema.auditLog).all()).toMatchObject([
      { actorUserId: "1001", action: "gameday.transition", targetId: DAY_ID },
    ]);
  });

  it("refuses an illegal move with the reason, not a stack trace", async () => {
    await day({ state: "PLAYED" });

    const response = await send("POST", `/api/game-days/${DAY_ID}/transition`, { to: "SEATING" });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: expect.stringContaining("PLAYED → SEATING"),
    });
    expect(await dayRow()).toMatchObject({ state: "PLAYED" });
  });

  it("wants to be told where to go", async () => {
    await day();
    expect((await send("POST", `/api/game-days/${DAY_ID}/transition`, {})).status).toBe(400);
  });

  it("is an organiser's to do", async () => {
    await day();
    roles = [];

    const response = await send("POST", `/api/game-days/${DAY_ID}/transition`, { to: "SEATING" });

    expect(response.status).toBe(403);
    expect(await dayRow()).toMatchObject({ state: "PROPOSED" });
    expect(await db(env).select().from(schema.sessions).all()).toEqual([]);
  });

  it("is behind the same gate as everything else", async () => {
    await day();
    const response = await app.fetch(
      new Request(`https://orrey.test/api/game-days/${DAY_ID}/transition`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ to: "SEATING" }),
      }),
      consoleEnv(),
    );

    expect(response.status).toBe(401);
  });
});
