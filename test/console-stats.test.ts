import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db, schema } from "../src/db/index.ts";
import { SETTING_KEYS, setSetting } from "../src/db/settings.ts";
import { createApp } from "../src/http/app.ts";
import { SESSION_COOKIE, issueSession } from "../src/console/cookies.ts";
import { SESSION_CONFIRMED, SESSION_MOVED } from "../src/db/audit.ts";
import { loadCampaignAttendance } from "../src/stats/campaign.ts";
import { loadScheduleStats } from "../src/stats/schedule.ts";
import { loadDaysStats } from "../src/stats/game-day.ts";
import type { Env, OutboxMessage } from "../src/env.ts";

/**
 * Two pages, and the promise that nothing on them reaches Discord.
 *
 * #47's third checkbox is the one that could quietly stop being true: a stats
 * page is exactly the thing somebody later wants a weekly summary post hung off.
 * So the absence of a post is asserted here rather than reasoned about.
 *
 * The other claim is that each route is a *view*: the numbers it returns are the
 * ones the three compute functions produce for the same fixtures, never a second
 * implementation that drifts from them.
 */
const app = createApp();
const realFetch = globalThis.fetch;
const MADE = Math.floor(Date.parse("2026-01-01T12:00:00Z") / 1000);
const HOUR = 3600;
const ORGANISER_ROLE = "role-organiser";

let calls: string[] = [];
let sent: OutboxMessage[] = [];

function consoleEnv(): Env {
  return {
    ...env,
    CONSOLE_SESSION_SECRET: "a-secret",
    DISCORD_APPLICATION_ID: "app-1",
    DISCORD_CLIENT_SECRET: "shh",
    DISCORD_BOT_TOKEN: "bot-token",
    OUTBOX: {
      send: async (body: OutboxMessage) => void sent.push(body),
      sendBatch: async (batch: Iterable<{ body: OutboxMessage }>) => {
        for (const { body } of batch) sent.push(body);
      },
    } as unknown as Env["OUTBOX"],
  } as Env;
}

async function get(path: string, signedIn = true) {
  // Minted from the real clock: the gate checks the cookie against the clock it
  // is running on, so a date written into this file is a test that fails on a
  // Tuesday.
  const cookie = `${SESSION_COOKIE}=${await issueSession(consoleEnv(), "1001", new Date())}`;
  return app.fetch(
    new Request(`https://orrey.test${path}`, {
      ...(signedIn ? { headers: { cookie } } : {}),
    }),
    consoleEnv(),
  );
}

async function seed() {
  await db(env)
    .insert(schema.campaigns)
    .values({ id: "umbra", name: "Age of Umbra", kind: "run", state: "RUNNING" });
  await db(env)
    .insert(schema.users)
    .values([
      { discordId: "1001", username: "ada", globalName: "Ada", feedToken: "t-1001" },
      { discordId: "b", username: "bo", globalName: "Bo", feedToken: "t-b" },
    ]);
  await db(env)
    .insert(schema.discordTokens)
    .values({
      userId: "1001",
      accessToken: "at",
      refreshToken: "rt",
      expiresAt: Math.floor(Date.now() / 1000) + 86_400,
    });
  await db(env)
    .insert(schema.campaignMembers)
    .values({ campaignId: "umbra", userId: "b", role: "player", joinedAt: MADE });

  for (const n of [1, 2]) {
    await db(env)
      .insert(schema.sessions)
      .values({
        id: `s${n}`,
        kind: "campaign_session",
        campaignId: "umbra",
        number: n,
        startsAt: MADE + n * 86_400,
        endsAt: MADE + n * 86_400 + 4 * HOUR,
        state: "PLAYED",
        createdAt: MADE,
      });
  }
  await db(env)
    .insert(schema.attendance)
    .values([
      { sessionId: "s1", userId: "b", attended: 1 },
      { sessionId: "s2", userId: "b", attended: 0 },
    ]);
  for (const [action, target, at] of [
    [SESSION_MOVED, "s2", MADE + HOUR],
    [SESSION_CONFIRMED, "s1", MADE + 5 * HOUR],
  ] as const) {
    await db(env)
      .insert(schema.auditLog)
      .values({
        id: crypto.randomUUID(),
        actorUserId: null,
        action,
        targetType: "session",
        targetId: target,
        createdAt: at,
      });
  }

  await db(env)
    .insert(schema.gameDays)
    .values({
      id: "day-1",
      kind: "single",
      state: "LOCKED",
      startsAt: MADE + 30 * 86_400,
      endsAt: MADE + 30 * 86_400 + 4 * HOUR,
      capacity: 4,
      waitlistAtLock: 2,
    });
  await db(env)
    .insert(schema.signups)
    .values([
      { targetType: "game_day", targetId: "day-1", userId: "b", state: "in" },
      { targetType: "game_day", targetId: "day-1", userId: "1001", state: "waitlisted" },
    ]);
}

beforeEach(async () => {
  calls = [];
  sent = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);
    if (url.includes("/members/")) return Response.json({ roles: [ORGANISER_ROLE] });
    return new Response("nothing here should be calling Discord", { status: 500 });
  }) as typeof fetch;

  for (const table of [
    "audit_log",
    "signups",
    "attendance",
    "campaign_members",
    "discord_tokens",
    "sessions",
    "game_days",
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

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("who may read them", () => {
  it("refuses the campaign page without a session", async () => {
    expect((await get("/api/campaigns/umbra/stats", false)).status).toBe(401);
  });

  it("refuses the game-day page without a session", async () => {
    expect((await get("/api/game-days/stats", false)).status).toBe(401);
  });
});

describe("each route is a view, not a second implementation", () => {
  it("returns exactly what the campaign compute functions produce", async () => {
    const res = await get("/api/campaigns/umbra/stats");
    expect(res.status).toBe(200);

    expect(await res.json()).toEqual({
      campaignId: "umbra",
      attendance: await loadCampaignAttendance(env, "umbra"),
      schedule: await loadScheduleStats(env, "umbra"),
    });
  });

  it("returns exactly what the game-day compute function produces", async () => {
    const res = await get("/api/game-days/stats");
    expect(res.status).toBe(200);

    const body = (await res.json()) as { days: unknown[] };
    expect(body.days).toEqual(await loadDaysStats(env));
  });

  it("averages the fill rate over the days that have one", async () => {
    // A multi day has no fill rate. Folding its null in as a zero would drag the
    // average down with evenings that were never going to be full.
    await db(env)
      .insert(schema.gameDays)
      .values({
        id: "day-2",
        kind: "multi",
        state: "LOCKED",
        startsAt: MADE + 31 * 86_400,
        endsAt: MADE + 31 * 86_400 + 4 * HOUR,
        waitlistAtLock: 0,
      });

    const body = (await (await get("/api/game-days/stats")).json()) as {
      averageFillRate: number | null;
    };

    // One seated of four on the only day with a capacity.
    expect(body.averageFillRate).toBe(0.25);
  });

  it("says nothing rather than zero when no day has a capacity", async () => {
    await env.DB.prepare("UPDATE game_days SET capacity = NULL, kind = 'multi'").run();

    const body = (await (await get("/api/game-days/stats")).json()) as {
      averageFillRate: number | null;
    };

    expect(body.averageFillRate).toBeNull();
  });
});

describe("nothing reaches Discord", () => {
  it("leaves the outbox empty and posts no message", async () => {
    await get("/api/campaigns/umbra/stats");
    await get("/api/game-days/stats");

    // #47's third checkbox, asserted rather than reasoned about. The only calls
    // either request makes are the gate's own role reads.
    expect(sent).toEqual([]);
    expect(calls.every((url) => url.includes("/members/"))).toBe(true);
    expect(calls.some((url) => url.includes("/messages"))).toBe(false);
  });

  it("writes nothing at all", async () => {
    const before = await db(env).select().from(schema.auditLog).all();

    await get("/api/campaigns/umbra/stats");
    await get("/api/game-days/stats");

    // A read that logged itself would be a write, and these are reads.
    expect(await db(env).select().from(schema.auditLog).all()).toEqual(before);
    expect(await db(env).select().from(schema.jobs).all()).toEqual([]);
  });
});
