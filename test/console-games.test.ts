import { env } from "cloudflare:test";
import { asc } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db, schema } from "../src/db/index.ts";
import { SETTING_KEYS, setSetting } from "../src/db/settings.ts";
import { createApp } from "../src/http/app.ts";
import { SESSION_COOKIE, issueSession } from "../src/console/cookies.ts";
import { gameRows } from "../src/console/games.ts";

/**
 * The games admin.
 *
 * The thing worth testing is the delete guard, and specifically that it is a
 * *query* rather than a catch. `campaigns.game_id` is `set null` on delete, so
 * there is no constraint to catch — a delete would succeed and quietly take the
 * game off four campaigns. Reading the holders first is the only thing standing
 * between an organiser and that, and it is also the only way to say *which*.
 */
const app = createApp();
const realFetch = globalThis.fetch;
const NOW = new Date("2026-09-14T12:00:00Z");
const seconds = Math.floor(NOW.getTime() / 1000);
const ORGANISER_ROLE = "role-organiser";

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
        cookie: `${SESSION_COOKIE}=${await issueSession(consoleEnv(), "1001", new Date())}`,
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    consoleEnv(),
  );
}

function audit() {
  return db(env)
    .select()
    .from(schema.auditLog)
    .orderBy(asc(schema.auditLog.createdAt))
    .all();
}

function games() {
  return db(env).select().from(schema.games).all();
}

async function game(
  id: string,
  name: string,
  over: Partial<typeof schema.games.$inferInsert> = {},
) {
  await db(env)
    .insert(schema.games)
    .values({ id, name, ...over });
  return id;
}

async function campaign(id: string, name: string, gameId: string | null) {
  await db(env)
    .insert(schema.campaigns)
    .values({ id, name, kind: "run", state: "RUNNING", gameId });
  return id;
}

beforeEach(async () => {
  roles = [ORGANISER_ROLE];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    if (url.includes("/members/")) return Response.json({ roles });
    return new Response("unexpected", { status: 500 });
  }) as typeof fetch;

  for (const table of [
    "audit_log",
    "signups",
    "attendance",
    "campaign_members",
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
  await db(env)
    .insert(schema.users)
    .values({ discordId: "1001", username: "ada", feedToken: "t" });
  // Against the real clock rather than `NOW`. `sessionFrom` compares this to the
  // clock it is actually running on, so an expiry anchored to a frozen date is a
  // day of life measured from a day already gone. Every test through here then
  // takes the refresh path into a fake fetch that has no token reply, and the
  // file turns red on a change to nothing.
  await db(env)
    .insert(schema.discordTokens)
    .values({
      userId: "1001",
      accessToken: "at",
      refreshToken: "rt",
      expiresAt: Math.floor(Date.now() / 1000) + 86_400,
    });
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("who is holding a game", () => {
  it("travels with the row, so a delete's cost is visible before it is attempted", async () => {
    await game("blades", "Blades in the Dark");
    await game("mausritter", "Mausritter");
    await campaign("umbra", "Age of Umbra", "blades");
    await campaign("deeps", "The Deeps", "blades");

    const rows = await gameRows(env);

    expect(rows.map((row) => row.id)).toEqual(["blades", "mausritter"]);
    expect(rows[0]?.usage.campaigns.map((held) => held.name)).toEqual([
      "Age of Umbra",
      "The Deeps",
    ]);
    expect(rows[1]?.usage.campaigns).toEqual([]);
  });

  it("counts the game days holding it too", async () => {
    await game("blades", "Blades in the Dark");
    await db(env)
      .insert(schema.gameDays)
      .values({
        id: "day-1",
        kind: "single",
        gameId: "blades",
        startsAt: seconds,
        endsAt: seconds + 3600,
      });

    expect((await gameRows(env))[0]?.usage.gameDays).toBe(1);
  });
});

describe("deleting one", () => {
  it("is refused, by name, when a campaign plays it", async () => {
    await game("blades", "Blades in the Dark");
    await campaign("umbra", "Age of Umbra", "blades");
    await campaign("deeps", "The Deeps", "blades");

    const res = await send("DELETE", "/api/games/blades");
    const body = (await res.json()) as { error: string };

    expect(res.status).toBe(400);
    // The names, not just "it is in use". An organiser who has to go and look up
    // which campaigns broke is one who will do it in the database instead.
    expect(body.error).toContain("Age of Umbra");
    expect(body.error).toContain("The Deeps");
    expect(await games()).toHaveLength(1);
  });

  it("is refused when a game day is on it", async () => {
    await game("blades", "Blades in the Dark");
    await db(env)
      .insert(schema.gameDays)
      .values({
        id: "day-1",
        kind: "single",
        gameId: "blades",
        startsAt: seconds,
        endsAt: seconds + 3600,
      });

    const res = await send("DELETE", "/api/games/blades");

    // `game_days.game_id` is `set null` as well, and a single day without its
    // game has no capacity to take.
    expect(res.status).toBe(400);
    expect(await games()).toHaveLength(1);
  });

  it("goes through when nobody is holding it, and lands one audit row", async () => {
    await game("blades", "Blades in the Dark");
    await campaign("umbra", "Age of Umbra", null);

    expect((await send("DELETE", "/api/games/blades")).status).toBe(200);

    expect(await games()).toEqual([]);
    const rows = await audit();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: "game.delete",
      targetType: "game",
      targetId: "blades",
      actorUserId: "1001",
    });
  });

  it("says so rather than reporting success for a game that was never there", async () => {
    const res = await send("DELETE", "/api/games/nothing");

    expect(res.status).toBe(400);
    expect(await audit()).toEqual([]);
  });
});

describe("what the form will not take", () => {
  it("refuses a minimum above the maximum", async () => {
    const res = await send("PUT", "/api/games/blades", {
      name: "Blades in the Dark",
      minPlayers: 6,
      maxPlayers: 4,
    });

    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toMatchObject({
      error: expect.stringContaining("more players than it seats"),
    });
    expect(await games()).toEqual([]);
  });
});

describe("who may", () => {
  it("refuses a delete from somebody who is not an organiser", async () => {
    await game("blades", "Blades in the Dark");
    roles = [];

    expect((await send("DELETE", "/api/games/blades")).status).toBe(403);
    expect(await games()).toHaveLength(1);
    expect(await audit()).toEqual([]);
  });

  it("refuses the list to them too", async () => {
    roles = [];
    expect((await send("GET", "/api/games/usage")).status).toBe(403);
  });
});
