import { env } from "cloudflare:test";
import { asc, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db, schema } from "../src/db/index.ts";
import { SETTING_KEYS, setSetting } from "../src/db/settings.ts";
import { createApp } from "../src/http/app.ts";
import { SESSION_COOKIE, issueSession } from "../src/console/cookies.ts";

/**
 * Rosters and games, entered the same way everything else is: through a domain
 * function, with the audit row in the same batch.
 */
const app = createApp();
const realFetch = globalThis.fetch;
const NOW = new Date("2026-09-14T12:00:00Z");
const seconds = Math.floor(NOW.getTime() / 1000);
const ORGANISER_ROLE = "role-organiser";
const CAMPAIGN = "age-of-umbra";

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

function audit() {
  return db(env).select().from(schema.auditLog).orderBy(asc(schema.auditLog.createdAt)).all();
}

function members() {
  return db(env).select().from(schema.campaignMembers).all();
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
    "attendance",
    "campaign_members",
    "sessions",
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
    .values({ userId: "1001", accessToken: "at", refreshToken: "rt", expiresAt: seconds + 86_400 });
  await db(env)
    .insert(schema.campaigns)
    .values({ id: CAMPAIGN, name: "Age of Umbra", kind: "run", state: "RUNNING" });
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("the roster", () => {
  it("adds somebody Orrey has never seen, and learns nothing it was not told", async () => {
    const response = await send("PUT", `/api/campaigns/${CAMPAIGN}/members`, {
      userId: "2002",
      role: "gm",
      characterName: "The GM",
    });

    expect(response.status).toBe(200);
    expect(await members()).toMatchObject([
      { userId: "2002", role: "gm", characterName: "The GM" },
    ]);

    // A person can be put on a roster before they have clicked anything. The row
    // is made with no names in it — those are a cache Orrey fills in when they
    // first speak to it.
    const user = await db(env)
      .select()
      .from(schema.users)
      .where(eq(schema.users.discordId, "2002"))
      .get();
    expect(user).toMatchObject({ username: null, globalName: null });
    expect(user?.feedToken).toMatch(/^[0-9a-v]{32}$/);
  });

  it("edits a member without rewriting when they joined", async () => {
    await send("PUT", `/api/campaigns/${CAMPAIGN}/members`, { userId: "2002", role: "player" });
    const joinedAt = (await members())[0]?.joinedAt;

    await send("PUT", `/api/campaigns/${CAMPAIGN}/members`, { userId: "2002", role: "gm" });

    const [row] = await members();
    expect(row).toMatchObject({ role: "gm" });
    expect(row?.joinedAt).toBe(joinedAt);
  });

  it("logs an add and an edit as different things", async () => {
    await send("PUT", `/api/campaigns/${CAMPAIGN}/members`, { userId: "2002", role: "player" });
    await send("PUT", `/api/campaigns/${CAMPAIGN}/members`, { userId: "2002", role: "gm" });

    expect((await audit()).map((row) => row.action)).toEqual(["member.add", "member.update"]);
    expect((await audit())[1]).toMatchObject({
      detail: { userId: "2002", before: { role: "player" }, after: { role: "gm" } },
    });
  });

  it("removes somebody, and keeps what they already answered", async () => {
    await send("PUT", `/api/campaigns/${CAMPAIGN}/members`, { userId: "2002" });
    await db(env).insert(schema.sessions).values({
      id: "s1",
      kind: "campaign_session",
      campaignId: CAMPAIGN,
      startsAt: seconds,
      endsAt: seconds + 3600,
    });
    await db(env)
      .insert(schema.attendance)
      .values({ sessionId: "s1", userId: "2002", intent: "in" });

    await send("DELETE", `/api/campaigns/${CAMPAIGN}/members/2002`);

    expect(await members()).toEqual([]);
    // Leaving the roster is not the same as never having been on it: they said
    // they were coming, and that is still true of them.
    expect(await db(env).select().from(schema.attendance).all()).toHaveLength(1);
  });

  it("removing somebody who is not there is not history", async () => {
    const response = await send("DELETE", `/api/campaigns/${CAMPAIGN}/members/9999`);

    expect(response.status).toBe(200);
    expect(await audit()).toEqual([]);
  });

  it("refuses a roster row with no id, and one for no campaign", async () => {
    expect((await send("PUT", `/api/campaigns/${CAMPAIGN}/members`, { userId: "" })).status).toBe(400);
    expect((await send("PUT", "/api/campaigns/nope/members", { userId: "2002" })).status).toBe(400);
  });

  it("refuses a role that is not one of the two", async () => {
    // There is no CHECK behind this column, and a type does not survive
    // `await c.req.json()`. "OWNER" used to be stored happily.
    const response = await send("PUT", `/api/campaigns/${CAMPAIGN}/members`, {
      userId: "2002",
      role: "OWNER",
    });

    expect(response.status).toBe(400);
    expect(await members()).toEqual([]);
  });

  it("records a removal and the removal itself together", async () => {
    await send("PUT", `/api/campaigns/${CAMPAIGN}/members`, { userId: "2002", role: "gm" });
    await env.DB.prepare("DELETE FROM audit_log").run();

    await send("DELETE", `/api/campaigns/${CAMPAIGN}/members/2002`);

    // Removing somebody and then failing to record it is the one outcome the
    // log cannot be read around afterwards, so the two go in one batch.
    expect(await audit()).toMatchObject([
      { action: "member.remove", detail: { userId: "2002", before: { role: "gm" } } },
    ]);
  });

  it("reads back with the cached names beside the ids", async () => {
    await send("PUT", `/api/campaigns/${CAMPAIGN}/members`, { userId: "1001", role: "gm" });

    const { roster } = (await (await send("GET", `/api/campaigns/${CAMPAIGN}/roster`)).json()) as {
      roster: Record<string, unknown>[];
    };
    expect(roster).toMatchObject([{ userId: "1001", role: "gm", username: "ada" }]);
  });
});

describe("games", () => {
  it("creates one at an id derived from the name", async () => {
    const response = await send("PUT", "/api/games", {
      name: "Mörk Borg",
      minPlayers: 3,
      maxPlayers: 5,
      defaultDurationMinutes: 240,
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: "m-rk-borg" });
    expect(await db(env).select().from(schema.games).get()).toMatchObject({
      name: "Mörk Borg",
      maxPlayers: 5,
    });
    expect((await audit()).map((row) => row.action)).toEqual(["game.create"]);
  });

  it("edits one at an id it is given", async () => {
    await send("PUT", "/api/games/ti", { name: "Twilight Imperium", maxPlayers: 6 });
    await send("PUT", "/api/games/ti", { name: "Twilight Imperium", maxPlayers: 8 });

    expect(await db(env).select().from(schema.games).get()).toMatchObject({ maxPlayers: 8 });
    expect((await audit()).map((row) => row.action)).toEqual(["game.create", "game.update"]);
  });

  it("refuses a game that needs more players than it seats", async () => {
    const response = await send("PUT", "/api/games", {
      name: "Impossible",
      minPlayers: 6,
      maxPlayers: 5,
    });

    // The CHECK says this too. Saying it here as well turns a constraint failure
    // into a sentence somebody can act on.
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: expect.stringContaining("more players than it seats"),
    });
    expect(await audit()).toEqual([]);
  });

  it("refuses a nameless game and a nonsense count", async () => {
    expect((await send("PUT", "/api/games", { name: "  " })).status).toBe(400);
    expect((await send("PUT", "/api/games", { name: "X", minPlayers: 0 })).status).toBe(400);

    // No name at all used to be a 500 on create, and a silent no-op on an edit:
    // drizzle drops `name: undefined`, so the request reported success and
    // changed nothing.
    expect((await send("PUT", "/api/games", { minPlayers: 3 })).status).toBe(400);
    expect((await send("PUT", "/api/games/ti", { maxPlayers: 6 })).status).toBe(400);
    expect(await db(env).select().from(schema.games).all()).toEqual([]);
  });
});

describe("all of it is an organiser's to do", () => {
  it("turns away everything without the role", async () => {
    roles = [];

    for (const [method, path, body] of [
      ["GET", `/api/campaigns/${CAMPAIGN}/roster`, undefined],
      ["PUT", `/api/campaigns/${CAMPAIGN}/members`, { userId: "2002" }],
      ["DELETE", `/api/campaigns/${CAMPAIGN}/members/2002`, undefined],
      ["PUT", "/api/games", { name: "X" }],
    ] as const) {
      expect((await send(method, path, body)).status, path).toBe(403);
    }
  });
});
