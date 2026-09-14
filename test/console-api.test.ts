import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db, schema } from "../src/db/index.ts";
import { SETTING_KEYS, setSetting } from "../src/db/settings.ts";
import { createApp } from "../src/http/app.ts";
import { SESSION_COOKIE, issueSession } from "../src/console/cookies.ts";

/**
 * The read half of the console. The claim worth testing is that everything on
 * the page comes from D1 — a console that read Discord back would be showing a
 * projection as though it were the thing projected.
 */
const app = createApp();
const realFetch = globalThis.fetch;
const NOW = new Date("2026-09-14T12:00:00Z");
const seconds = Math.floor(NOW.getTime() / 1000);
const ORGANISER_ROLE = "role-organiser";

let discordCalls: string[] = [];
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

async function signedIn() {
  return `${SESSION_COOKIE}=${await issueSession(consoleEnv(), "1001", NOW)}`;
}

function get(path: string, cookie?: string) {
  return app.fetch(
    new Request(`https://orrey.test${path}`, cookie ? { headers: { cookie } } : {}),
    consoleEnv(),
  );
}

beforeEach(async () => {
  discordCalls = [];
  roles = [ORGANISER_ROLE];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    discordCalls.push(url);
    if (url.includes("/members/")) return Response.json({ roles });
    return new Response("unexpected", { status: 500 });
  }) as typeof fetch;

  for (const table of ["campaign_members", "sessions", "campaigns", "games", "discord_tokens", "users", "settings"]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  await setSetting(env, SETTING_KEYS.guildId, "g1");
  await setSetting(env, SETTING_KEYS.organiserRoleId, ORGANISER_ROLE);

  await db(env).insert(schema.users).values({ discordId: "1001", username: "ada", feedToken: "t" });
  await db(env)
    .insert(schema.discordTokens)
    .values({ userId: "1001", accessToken: "at", refreshToken: "rt", expiresAt: seconds + 86_400 });
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("the console's read routes", () => {
  it("turns away anybody who is not an organiser", async () => {
    expect((await get("/api/campaigns")).status).toBe(401);
    expect((await get("/api/games")).status).toBe(401);

    roles = [];
    expect((await get("/api/campaigns", await signedIn())).status).toBe(403);
  });

  it("lists campaigns with the numbers the page shows", async () => {
    await db(env)
      .insert(schema.games)
      .values({ id: "mork-borg", name: "Mörk Borg", minPlayers: 3, maxPlayers: 5 });
    await db(env).insert(schema.campaigns).values({
      id: "age-of-umbra",
      name: "Age of Umbra",
      kind: "run",
      state: "RUNNING",
      gameId: "mork-borg",
      recurrenceAnchor: seconds,
      intervalWeeks: 2,
      firstSessionNumber: 12,
    });
    await db(env)
      .insert(schema.campaignMembers)
      .values({ campaignId: "age-of-umbra", userId: "1001" });
    await db(env).insert(schema.sessions).values([
      { id: "s1", kind: "campaign_session", campaignId: "age-of-umbra", startsAt: seconds, endsAt: seconds + 3600 },
      { id: "s2", kind: "campaign_session", campaignId: "age-of-umbra", startsAt: seconds, endsAt: seconds + 3600 },
    ]);

    const response = await get("/api/campaigns", await signedIn());
    expect(response.status).toBe(200);

    const { campaigns } = (await response.json()) as { campaigns: Record<string, unknown>[] };
    expect(campaigns).toMatchObject([
      {
        id: "age-of-umbra",
        state: "RUNNING",
        gameName: "Mörk Borg",
        intervalWeeks: 2,
        firstSessionNumber: 12,
        members: 1,
        sessions: 2,
      },
    ]);

    // The only thing asked of Discord is the role. Nothing on this page comes
    // from there.
    expect(discordCalls.every((url) => url.includes("/members/"))).toBe(true);
  });

  it("counts zero rather than omitting a campaign nobody is on", async () => {
    await db(env)
      .insert(schema.campaigns)
      .values({ id: "new-thing", name: "New Thing", kind: "run", state: "FORMING" });

    const { campaigns } = (await (await get("/api/campaigns", await signedIn())).json()) as {
      campaigns: { members: number; sessions: number }[];
    };
    expect(campaigns).toMatchObject([{ members: 0, sessions: 0 }]);
  });

  it("counts a forming campaign's claimants as its roster", async () => {
    await db(env)
      .insert(schema.campaigns)
      .values({ id: "new-thing", name: "New Thing", kind: "run", state: "FORMING" });
    await db(env)
      .insert(schema.users)
      .values({ discordId: "2002", username: "bob", feedToken: "t2" });
    await db(env).insert(schema.signups).values({
      targetType: "campaign_forming",
      targetId: "new-thing",
      userId: "2002",
      state: "in",
    });

    const { campaigns } = (await (await get("/api/campaigns", await signedIn())).json()) as {
      campaigns: { members: number }[];
    };

    // Before this, the console said "Roster 0" beside a campaign with a
    // claimant — disagreeing with the attendance post about the same question.
    expect(campaigns).toMatchObject([{ members: 1 }]);
  });

  it("lists games", async () => {
    await db(env)
      .insert(schema.games)
      .values({ id: "ti", name: "Twilight Imperium", minPlayers: 3, maxPlayers: 6, defaultDurationMinutes: 480 });

    const { games } = (await (await get("/api/games", await signedIn())).json()) as {
      games: Record<string, unknown>[];
    };
    expect(games).toMatchObject([{ id: "ti", maxPlayers: 6, defaultDurationMinutes: 480 }]);
  });
});

describe("the page itself", () => {
  it("is served at /console", async () => {
    const response = await get("/console");
    expect(response.status).toBe(200);

    const html = await response.text();
    expect(html).toContain("Orrey console");
    expect(html).toContain("/console/console.js");
  });

  it("says something true on the holding page", async () => {
    const html = await (await get("/")).text();
    expect(html).not.toContain("lands in phase 2");
    expect(html).toContain("/console");
  });
});
