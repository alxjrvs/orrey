import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db, schema } from "../src/db/index.ts";
import { SETTING_KEYS, setSetting } from "../src/db/settings.ts";
import { createApp } from "../src/http/app.ts";
import { SESSION_COOKIE, issueSession } from "../src/console/cookies.ts";
import { agendaBetween, windowAround } from "../src/console/agenda.ts";
import { upcomingWithTotal } from "../src/commands/upcoming.ts";

/**
 * One query behind two agendas.
 *
 * What is worth testing is the window's edges, the rule about which sessions
 * count at all, and that "no reply" is a roster fact rather than a zero — plus
 * that `/upcoming` now reads this and gets the same numbers it always did.
 */
const app = createApp();
const realFetch = globalThis.fetch;
const ORGANISER_ROLE = "role-organiser";
const NOW = new Date("2026-11-01T12:00:00Z");
const START = Math.floor(NOW.getTime() / 1000);
const DAY = 86_400;

function consoleEnv() {
  return {
    ...env,
    CONSOLE_SESSION_SECRET: "a-secret",
    DISCORD_APPLICATION_ID: "app-1",
    DISCORD_CLIENT_SECRET: "shh",
    DISCORD_BOT_TOKEN: "bot-token",
  };
}

async function get(path: string, withCookie = true) {
  return app.fetch(
    new Request(`https://orrey.test${path}`, {
      headers: withCookie
        ? { cookie: `${SESSION_COOKIE}=${await issueSession(consoleEnv(), "1001", new Date())}` }
        : {},
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

async function campaign(
  id: string,
  over: Partial<typeof schema.campaigns.$inferInsert> = {},
) {
  await db(env)
    .insert(schema.campaigns)
    .values({ id, name: id, kind: "run", state: "RUNNING", quorum: 3, ...over });
}

async function member(campaignId: string, userId: string) {
  await person(userId);
  await db(env).insert(schema.campaignMembers).values({ campaignId, userId });
}

async function session(
  id: string,
  campaignId: string | null,
  startsAt: number,
  over: Partial<typeof schema.sessions.$inferInsert> = {},
) {
  await db(env)
    .insert(schema.sessions)
    .values({
      id,
      kind: campaignId ? "campaign_session" : "one_off",
      ...(campaignId ? { campaignId } : {}),
      number: 1,
      startsAt,
      endsAt: startsAt + 4 * 3600,
      ...over,
    });
  return id;
}

async function said(sessionId: string, userId: string, intent: "in" | "out" | "maybe") {
  await person(userId);
  await db(env).insert(schema.attendance).values({ sessionId, userId, intent });
}

function agenda(from = START, to = START + 30 * DAY) {
  return agendaBetween(env, from, to, NOW);
}

beforeEach(async () => {
  // The console reads roles from Discord with the bot token on every request —
  // nothing is cached, so every test that touches a route has to answer.
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("/members/")) return Response.json({ roles: [ORGANISER_ROLE] });
    return new Response("unexpected", { status: 500 });
  }) as typeof fetch;

  for (const table of [
    "attendance",
    "signups",
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
  await person("1001");
  await db(env)
    .insert(schema.discordTokens)
    .values({ userId: "1001", accessToken: "at", refreshToken: "rt", expiresAt: START + DAY });
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("the window", () => {
  it("is half-open at the far end", async () => {
    await campaign("umbra");
    await session("a", "umbra", START + DAY);
    await session("b", "umbra", START + 7 * DAY);

    // A session starting exactly at `to` belongs to the next window, or a month
    // grid shows the first of next month twice.
    const { rows } = await agenda(START, START + 7 * DAY);
    expect(rows.map((row) => row.sessionId)).toEqual(["a"]);
  });

  it("is closed at the near end", async () => {
    await campaign("umbra");
    await session("a", "umbra", START);

    expect((await agenda(START, START + DAY)).rows.map((row) => row.sessionId)).toEqual(["a"]);
  });

  it("takes a window that has already been", async () => {
    await campaign("umbra");
    await session("a", "umbra", START - 10 * DAY, { state: "PLAYED" });

    // The month grid asks for months that are over, which is why the window is
    // an argument rather than a hardcoded "upcoming".
    expect((await agenda(START - 30 * DAY, START)).rows).toHaveLength(1);
  });

  it("carries an as-of, taken from the argument and not the clock", async () => {
    expect((await agenda()).asOf).toBe(START);
  });
});

describe("what counts", () => {
  it("leaves out a campaign on hiatus", async () => {
    await campaign("umbra", { state: "HIATUS" });
    await session("a", "umbra", START + DAY);

    // The same rule `isProjectable` applies: a console that lists a session
    // Orrey is not putting on anybody's calendar shows a plan Discord does not
    // have.
    expect((await agenda()).rows).toEqual([]);
  });

  it("leaves out a campaign that is forming, and one that has concluded", async () => {
    for (const [id, state] of [["a", "FORMING"], ["b", "CONCLUDED"]] as const) {
      await campaign(id, { state });
      await session(`s-${id}`, id, START + DAY);
    }

    expect((await agenda()).rows).toEqual([]);
  });

  it("takes a game day that is seating, and not one that is only proposed", async () => {
    await db(env)
      .insert(schema.games)
      .values({ id: "blades", name: "Blades in the Dark", minPlayers: 3, maxPlayers: 4 });
    for (const [id, state] of [["open", "SEATING"], ["shut", "PROPOSED"]] as const) {
      await db(env)
        .insert(schema.gameDays)
        .values({
          id,
          kind: "single",
          gameId: "blades",
          state,
          startsAt: START + DAY,
          endsAt: START + DAY + 4 * 3600,
        });
      await session(`s-${id}`, null, START + DAY, { gameDayId: id });
    }

    expect((await agenda()).rows.map((row) => row.sessionId)).toEqual(["s-open"]);
  });

  it("keeps a cancelled session, because the console has to show it was", async () => {
    await campaign("umbra");
    await session("a", "umbra", START + DAY, { state: "CANCELLED" });

    // The rule is about the *parent*. What a page does with a cancelled session
    // is the page's business — `/upcoming` drops it, the month grid shows it
    // struck through.
    expect((await agenda()).rows).toHaveLength(1);
  });
});

describe("the tally", () => {
  it("counts no reply against the roster rather than reporting zero", async () => {
    await campaign("umbra");
    for (const who of ["a", "b", "c", "d"]) await member("umbra", who);
    await session("s", "umbra", START + DAY);
    await said("s", "a", "in");
    await said("s", "b", "out");

    const [row] = (await agenda()).rows;
    expect(row?.rosterSize).toBe(4);
    expect(row?.tally).toEqual({ in: 1, out: 1, maybe: 0, noReply: 2 });
  });

  it("never goes negative when somebody answered and then left the roster", async () => {
    await campaign("umbra");
    await member("umbra", "a");
    await session("s", "umbra", START + DAY);
    await said("s", "a", "in");
    await said("s", "gone", "in");

    expect((await agenda()).rows[0]?.tally.noReply).toBe(0);
  });

  it("counts a game day's roster as its seated signups", async () => {
    await db(env).insert(schema.games).values({ id: "blades", name: "Blades", minPlayers: 3 });
    await db(env)
      .insert(schema.gameDays)
      .values({
        id: "day",
        kind: "single",
        gameId: "blades",
        state: "SEATING",
        startsAt: START + DAY,
        endsAt: START + DAY + 4 * 3600,
      });
    for (const who of ["a", "b", "c"]) await person(who);
    await db(env)
      .insert(schema.signups)
      .values([
        { targetType: "game_day", targetId: "day", userId: "a", state: "in", position: 1 },
        { targetType: "game_day", targetId: "day", userId: "b", state: "in", position: 2 },
        { targetType: "game_day", targetId: "day", userId: "c", state: "waitlisted", position: 3 },
      ]);
    await session("s", null, START + DAY, { gameDayId: "day" });

    // The queue behind the table is not the table.
    const [row] = (await agenda()).rows;
    expect(row?.rosterSize).toBe(2);
    expect(row?.quorum.required).toBe(3);
  });
});

describe("jeopardy", () => {
  it("is read off the session state and never recomputed", async () => {
    await campaign("umbra", { quorum: 9 });
    await member("umbra", "a");
    await session("s", "umbra", START + DAY);

    // Short of quorum, but the clock has not been past yet, so it is not in
    // jeopardy — the check is what decides, and a page that decided again would
    // disagree with the notice that went out.
    expect((await agenda()).rows[0]?.inJeopardy).toBe(false);

    await db(env).update(schema.sessions).set({ state: "JEOPARDY" });
    expect((await agenda()).rows[0]?.inJeopardy).toBe(true);
  });
});

describe("the route", () => {
  it("answers the envelope", async () => {
    await campaign("umbra");
    await session("a", "umbra", START + DAY);

    const res = await get(`/api/agenda?from=${START}&to=${START + 30 * DAY}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { asOf: number; rows: { sessionId: string }[] };
    expect(typeof body.asOf).toBe("number");
    expect(body.rows.map((row) => row.sessionId)).toEqual(["a"]);
  });

  it("takes a window, and defaults to the fortnight ahead", async () => {
    await campaign("umbra");
    await session("far", "umbra", START + 60 * DAY);

    // The default is a fortnight from *now*, which this session is well past.
    expect(((await (await get("/api/agenda")).json()) as { rows: [] }).rows).toEqual([]);

    const res = await get(`/api/agenda?from=${START}&to=${START + 90 * DAY}`);
    expect(((await res.json()) as { rows: { sessionId: string }[] }).rows).toHaveLength(1);
  });

  it("refuses a window that is not one", async () => {
    expect((await get(`/api/agenda?from=${START}&to=${START}`)).status).toBe(400);
    expect((await get("/api/agenda?from=not&to=a-number")).status).toBe(400);
  });

  it("is behind the same gate as everything else", async () => {
    expect((await get("/api/agenda", false)).status).toBe(401);
  });
});

describe("what /upcoming gets from it", () => {
  it("is the same numbers, from the one query", async () => {
    await campaign("umbra", { quorum: 2 });
    for (const who of ["1001", "b", "c"]) await member("umbra", who);
    await session("s", "umbra", START + DAY);
    await said("s", "1001", "in");
    await said("s", "b", "in");

    const { entries } = await upcomingWithTotal(env, "1001", NOW);
    const [row] = (await agenda()).rows;

    expect(entries[0]?.quorum).toEqual(row?.quorum);
    expect(entries[0]?.mine).toBe("in");
  });

  it("stops listing a campaign that went on hiatus", async () => {
    await campaign("umbra", { state: "HIATUS" });
    await member("umbra", "1001");
    await session("s", "umbra", START + DAY);

    // A session Orrey is not putting on anybody's calendar is not one to put on
    // somebody's agenda either.
    expect((await upcomingWithTotal(env, "1001", NOW)).entries).toEqual([]);
  });
});

describe("windowAround", () => {
  it("starts now and runs forward", () => {
    expect(windowAround(NOW, 14)).toEqual({ from: START, to: START + 14 * DAY });
  });
});
