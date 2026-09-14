import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db, schema } from "../src/db/index.ts";
import { SETTING_KEYS, setSetting } from "../src/db/settings.ts";
import { createApp } from "../src/http/app.ts";
import { SESSION_COOKIE, issueSession } from "../src/console/cookies.ts";
import { gameDayPage } from "../src/console/game-day.ts";
import { sessionIdFor } from "../src/game-days/lifecycle.ts";
import { claimSeat, withdraw } from "../src/game-days/signups.ts";

/**
 * The game day's page.
 *
 * The claim it exists to hold up is the CHECK constraint from `CLAUDE.md`, and
 * this is the first screen anybody could see it on: signups hang off the **day**
 * and attendance hangs off the **session** the day owns. They are two different
 * lists of people, and this page shows them as two.
 */
const app = createApp();
const realFetch = globalThis.fetch;
const NOW = new Date("2026-11-01T12:00:00Z");
const seconds = Math.floor(NOW.getTime() / 1000);
const DAY_ID = "day-1";
const SESSION_ID = sessionIdFor(DAY_ID);
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
      headers: { cookie: `${SESSION_COOKIE}=${await issueSession(consoleEnv(), "1001", NOW)}` },
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

async function day(over: Partial<typeof schema.gameDays.$inferInsert> = {}) {
  await db(env)
    .insert(schema.gameDays)
    .values({
      id: DAY_ID,
      kind: "single",
      state: "SEATING",
      startsAt: seconds + 7 * 86_400,
      endsAt: seconds + 7 * 86_400 + 4 * 3600,
      title: "Blades at the Wreck",
      venue: "The Wreck",
      gameId: "blades",
      discordChannelId: "chan-1",
      discordMessageId: "msg-1",
      ...over,
    });
  await db(env)
    .insert(schema.sessions)
    .values({
      id: SESSION_ID,
      kind: "one_off",
      gameDayId: DAY_ID,
      startsAt: seconds + 7 * 86_400,
      endsAt: seconds + 7 * 86_400 + 4 * 3600,
    });
  return DAY_ID;
}

async function claim(userId: string) {
  await person(userId);
  return claimSeat(env, DAY_ID, userId);
}

/** The evening happened. Seats are claimed before this, never after. */
async function played() {
  await db(env)
    .update(schema.gameDays)
    .set({ state: "PLAYED" })
    .where(eq(schema.gameDays.id, DAY_ID));
}

/** A register row on the session the day owns — never on the day. */
async function onRegister(userId: string, attended: boolean, tablesPlayed?: string) {
  await person(userId);
  await db(env)
    .insert(schema.attendance)
    .values({
      sessionId: SESSION_ID,
      userId,
      intent: "in",
      attended: attended ? 1 : 0,
      attendedSource: "auto",
      ...(tablesPlayed === undefined ? {} : { tablesPlayed }),
    });
}

beforeEach(async () => {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("/members/")) return Response.json({ roles: [ORGANISER_ROLE] });
    return new Response("unexpected", { status: 500 });
  }) as typeof fetch;

  for (const table of [
    "attendance",
    "signups",
    "sessions",
    "game_days",
    "games",
    "campaigns",
    "discord_tokens",
    "users",
    "settings",
  ]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  await setSetting(env, SETTING_KEYS.guildId, "g1");
  await setSetting(env, SETTING_KEYS.organiserRoleId, ORGANISER_ROLE);
  await db(env)
    .insert(schema.games)
    .values({ id: "blades", name: "Blades in the Dark", minPlayers: 3, maxPlayers: 4 });
  await person("1001");
  await db(env)
    .insert(schema.discordTokens)
    .values({ userId: "1001", accessToken: "at", refreshToken: "rt", expiresAt: seconds + 86_400 });
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("the waitlist", () => {
  it("follows signups.position rather than the order they are read back in", async () => {
    await day();
    for (const who of ["a", "b", "c", "d", "e", "f"]) await claim(who);

    const page = (await gameDayPage(env, DAY_ID))!;

    // Four seats from the game, so two behind them — and the two in the order
    // they arrived, which is the only order a queue can honestly be in.
    expect(page.seated.map((row) => row.userId)).toEqual(["a", "b", "c", "d"]);
    expect(page.waitlist.map((row) => row.userId)).toEqual(["e", "f"]);
  });

  it("stays in order after somebody leaves from the middle of it", async () => {
    await day();
    for (const who of ["a", "b", "c", "d", "e", "f", "g"]) await claim(who);

    await withdraw(env, DAY_ID, "f");

    // `position` is arrival order and is never renumbered, so a gap in it is not
    // a gap in the queue. A page that sorted on anything else would put `g`
    // ahead of `e` the first time anybody left.
    const page = (await gameDayPage(env, DAY_ID))!;
    expect(page.waitlist.map((row) => row.userId)).toEqual(["e", "g"]);
  });

  it("counts the seats left against the capacity, not against the list", async () => {
    await day();
    for (const who of ["a", "b"]) await claim(who);

    const page = (await gameDayPage(env, DAY_ID))!;
    expect(page.capacity).toBe(4);
    expect(page.seatsLeft).toBe(2);
  });
});

describe("capacity", () => {
  it("comes from the game on a single day", async () => {
    await day();
    expect((await gameDayPage(env, DAY_ID))!.capacity).toBe(4);
  });

  it("is the day's own number when the day overrides it", async () => {
    await day({ capacity: 5 });
    // The evening the table only has five chairs.
    expect((await gameDayPage(env, DAY_ID))!.capacity).toBe(5);
  });

  it("is nothing on a multi day with no cap of its own", async () => {
    await day({ kind: "multi", gameId: null });

    // A multi day has no single game to ask, so "however many turn up" is the
    // honest answer and `seatsLeft` has nothing to count down from.
    const page = (await gameDayPage(env, DAY_ID))!;
    expect(page.capacity).toBeNull();
    expect(page.seatsLeft).toBeNull();
  });
});

describe("two lists, never one", () => {
  it("keeps the signups and the register apart", async () => {
    // Seated while the day was seating, then played — which is the only order
    // this can happen in, and the reason the two lists drift apart at all.
    await day();
    await claim("a");
    await claim("b");
    await played();
    // Somebody who never signed up but turned up anyway, and somebody who held a
    // seat all week and did not.
    await onRegister("c", true);
    await onRegister("a", false);

    const page = (await gameDayPage(env, DAY_ID))!;

    // Signups attach to the day; attendance attaches to the session the day
    // owns. Merging them would imply a signup is an intent, and it is not: `b`
    // holds a seat and has no register row, `c` came and never claimed one.
    expect(page.seated.map((row) => row.userId)).toEqual(["a", "b"]);
    expect(page.register.map((row) => row.userId)).toEqual(["a", "c"]);
  });

  it("says nobody wrote the register rather than that they did not come", async () => {
    await day();
    await played();
    await person("a");
    await db(env)
      .insert(schema.attendance)
      .values({ sessionId: SESSION_ID, userId: "a", intent: "in" });

    expect((await gameDayPage(env, DAY_ID))!.register[0]).toMatchObject({
      userId: "a",
      attended: null,
    });
  });
});

describe("what was played", () => {
  it("is nothing at all on a single day", async () => {
    await day();
    await played();
    await onRegister("a", true, "Blades");

    // One table, so nothing to record. The column exists for days where several
    // ran alongside each other.
    expect((await gameDayPage(env, DAY_ID))!.tables).toBeNull();
  });

  it("is nothing before the day has been played", async () => {
    await day({ kind: "multi", gameId: null, state: "SEATING" });
    await onRegister("a", true, "Blades");

    // What somebody *did* play is not a question to ask of an evening that has
    // not happened. A row here before then would be a plan wearing a record's
    // clothes.
    expect((await gameDayPage(env, DAY_ID))!.tables).toBeNull();
  });

  it("is one line per person on the register once the day is played", async () => {
    await day({ kind: "multi", gameId: null });
    await played();
    await onRegister("a", true, "Blades, then Mausritter");
    await onRegister("b", true);

    const tables = (await gameDayPage(env, DAY_ID))!.tables!;

    // Per person, because the row is already keyed `(session_id, user_id)` —
    // there is no `tables` table and no per-table seating. Somebody who has not
    // said gets a null rather than being left out.
    expect(tables).toEqual([
      { userId: "a", name: "Player a", tablesPlayed: "Blades, then Mausritter" },
      { userId: "b", name: "Player b", tablesPlayed: null },
    ]);
  });
});

describe("where the day may go", () => {
  it("offers the edges its own map offers, and nothing from a terminal state", async () => {
    await day({ state: "SEATING" });
    expect((await gameDayPage(env, DAY_ID))!.nextStates).toEqual(["LOCKED", "CANCELLED"]);

    await db(env)
      .update(schema.gameDays)
      .set({ state: "CANCELLED" })
      .where(eq(schema.gameDays.id, DAY_ID));
    expect((await gameDayPage(env, DAY_ID))!.nextStates).toEqual([]);
  });
});

describe("over HTTP", () => {
  it("answers with the day, its links assembled from ids", async () => {
    await day({ threadId: "thread-1" });
    await claim("a");

    const res = await get(`/api/game-days/${DAY_ID}/page`);
    const body = (await res.json()) as Awaited<ReturnType<typeof gameDayPage>>;

    expect(res.status).toBe(200);
    expect(body?.postUrl).toBe("https://discord.com/channels/g1/chan-1/msg-1");
    expect(body?.threadUrl).toBe("https://discord.com/channels/g1/thread-1");
    expect(body?.seated).toHaveLength(1);
  });

  it("says it does not know a day rather than returning an empty one", async () => {
    const res = await get("/api/game-days/nowhere/page");
    expect(res.status).toBe(404);
  });
});
