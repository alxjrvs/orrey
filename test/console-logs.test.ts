import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db, schema } from "../src/db/index.ts";
import { createApp } from "../src/http/app.ts";
import { SESSION_COOKIE, issueSession } from "../src/console/cookies.ts";
import { campaignHistory } from "../src/console/campaign-history.ts";
import { sessionDetail } from "../src/console/session-detail.ts";
import { logsForCampaign, logsForSession } from "../src/console/logs.ts";
import { sessionLogs } from "../src/logs/session-log.ts";
import { SETTING_KEYS, setSetting } from "../src/db/settings.ts";

/**
 * The read side of the log, and the second door on to the one writer.
 *
 * The claim worth testing is that the console door is `writeRecap` and nothing
 * else: same permission check, same normalisation, same row, same post into the
 * thread. A console recap that landed in D1 and never reached Discord is what
 * this phase is least likely to notice, so the thread post is asserted on the
 * fake fetch rather than assumed.
 */
const app = createApp();
const realFetch = globalThis.fetch;
const START = Math.floor(Date.parse("2026-09-20T18:00:00Z") / 1000);
const GM = "gm-1";
const PLAYER = "p-1";
const ORGANISER_ROLE = "role-organiser";

let posts: { path: string; body: Record<string, unknown> }[] = [];

function consoleEnv() {
  return {
    ...env,
    CONSOLE_SESSION_SECRET: "a-secret",
    DISCORD_APPLICATION_ID: "app-1",
    DISCORD_CLIENT_SECRET: "shh",
    DISCORD_BOT_TOKEN: "bot-token",
  };
}

async function send(method: string, path: string, body?: unknown, userId = GM) {
  // Minted against the real clock: the gate checks the cookie's expiry against
  // the clock it is running on, so a fixed date is a test that fails on a
  // Tuesday.
  const cookie = `${SESSION_COOKIE}=${await issueSession(consoleEnv(), userId, new Date())}`;
  return app.fetch(
    new Request(`https://orrey.test${path}`, {
      method,
      headers: { cookie, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    consoleEnv(),
  );
}

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
      .values({ discordId: id, username: id, globalName: `Player ${id}`, feedToken: `t-${id}` })
      .onConflictDoNothing();
    await db(env).insert(schema.campaignMembers).values({ campaignId: "umbra", userId: id, role });
    // The console session carries an access token as well as a cookie, and both
    // are checked against the clock the route is running on — so both are
    // minted from it rather than from a date written into this file.
    await db(env)
      .insert(schema.discordTokens)
      .values({
        userId: id,
        accessToken: "at",
        refreshToken: "rt",
        expiresAt: Math.floor(Date.now() / 1000) + 86_400,
      });
  }
  for (const number of [11, 12]) {
    await db(env)
      .insert(schema.sessions)
      .values({
        id: `umbra-s${number}`,
        kind: "campaign_session",
        campaignId: "umbra",
        number,
        startsAt: START + number * 86_400,
        endsAt: START + number * 86_400 + 4 * 3600,
        state: "PLAYED",
        threadId: `thread-${number}`,
      });
  }
}

async function log(sessionId: string, body: string, author = GM) {
  await db(env).insert(schema.sessionLogs).values({ sessionId, author, body });
}

beforeEach(async () => {
  posts = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    // The console gate reads the member's roles off the bot token. Everything
    // else through here is a message going up.
    if (url.pathname.includes("/members/")) return Response.json({ roles: [ORGANISER_ROLE] });

    posts.push({
      path: url.pathname.replace("/api/v10", ""),
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
    });
    return Response.json({ id: `msg-${posts.length}`, channel_id: "chan-1" });
  }) as typeof fetch;

  for (const table of [
    "session_logs",
    "discord_tokens",
    "attendance",
    "campaign_members",
    "sessions",
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

describe("one session's log", () => {
  it("comes back oldest first, with the author's name", async () => {
    await log("umbra-s12", "First.");
    await log("umbra-s12", "Second.");

    const entries = await logsForSession(env, "umbra-s12");

    expect(entries.map((entry) => entry.body)).toEqual(["First.", "Second."]);
    expect(entries[0]?.authorName).toBe(`Player ${GM}`);
  });

  it("falls back to the id when the name cache has not caught up", async () => {
    await db(env).insert(schema.users).values({ discordId: "ghost", feedToken: "t-ghost" });
    await log("umbra-s12", "Somebody wrote this.", "ghost");

    // `users` is a cache. A log whose author has no cached name is still a log,
    // and an empty line would read as a bug in the page.
    expect((await logsForSession(env, "umbra-s12"))[0]?.authorName).toBe("ghost");
  });

  it("is on the rail", async () => {
    await log("umbra-s12", "It went well.");

    expect((await sessionDetail(env, "umbra-s12"))?.logs.map((entry) => entry.body)).toEqual([
      "It went well.",
    ]);
  });

  it("is empty for a session nobody wrote up", async () => {
    expect((await sessionDetail(env, "umbra-s12"))?.logs).toEqual([]);
  });
});

describe("a campaign's logs", () => {
  it("are grouped under the session each belongs to, in date order", async () => {
    await log("umbra-s12", "The twelfth.");
    await log("umbra-s11", "The eleventh.");
    await log("umbra-s11", "And more of it.");

    const groups = await logsForCampaign(env, "umbra");

    expect(groups.map((group) => group.number)).toEqual([11, 12]);
    expect(groups[0]?.entries.map((entry) => entry.body)).toEqual([
      "The eleventh.",
      "And more of it.",
    ]);
  });

  it("leave out the sessions nobody wrote up", async () => {
    await log("umbra-s12", "Only this one.");

    // A heading over nothing is not history, it is a blank row.
    const groups = await logsForCampaign(env, "umbra");
    expect(groups).toHaveLength(1);
    expect(groups[0]?.sessionId).toBe("umbra-s12");
  });

  it("ride along with the record the page already reads", async () => {
    await log("umbra-s11", "Written up.");

    expect((await campaignHistory(env, "umbra")).logs).toHaveLength(1);
  });

  it("are nothing at all for a campaign with no sessions", async () => {
    await db(env)
      .insert(schema.campaigns)
      .values({ id: "empty", name: "Nothing yet", kind: "run", state: "FORMING" });

    expect(await logsForCampaign(env, "empty")).toEqual([]);
  });
});

describe("the console's door on to the writer", () => {
  it("writes the row and posts the message, in that order", async () => {
    const res = await send("POST", "/api/sessions/umbra-s12/recap", { body: "It went well." });

    expect(res.status).toBe(201);
    expect((await sessionLogs(env, "umbra-s12")).map((entry) => entry.body)).toEqual([
      "It went well.",
    ]);
    // The same post the modal produces, into the session's thread. Proved on the
    // fake fetch rather than assumed: a console recap that never reached Discord
    // is the failure this slice is written against.
    expect(posts).toMatchObject([{ path: "/channels/thread-12/messages" }]);
    expect(posts[0]?.body).toMatchObject({
      content: expect.stringContaining("It went well."),
    });
  });

  it("keeps the newlines a note would lose", async () => {
    await send("POST", "/api/sessions/umbra-s12/recap", {
      body: "One thing.\n\n\n\nAnd another.   ",
    });

    // `normaliseLogBody`, unchanged — runs of blank lines collapse to one and
    // trailing whitespace goes, but the paragraph break survives.
    expect((await sessionLogs(env, "umbra-s12"))[0]?.body).toBe("One thing.\n\nAnd another.");
  });

  it("refuses the same person the modal refuses", async () => {
    const res = await send("POST", "/api/sessions/umbra-s12/recap", { body: "Mine now." }, PLAYER);

    expect(res.status).toBe(403);
    expect(await sessionLogs(env, "umbra-s12")).toEqual([]);
    expect(posts).toEqual([]);
  });

  it("writes nothing for an empty box, and says so", async () => {
    const res = await send("POST", "/api/sessions/umbra-s12/recap", { body: "   \n  " });

    expect(res.status).toBe(400);
    expect(await sessionLogs(env, "umbra-s12")).toEqual([]);
    expect(posts).toEqual([]);
  });

  it("says it does not know a session that is not there", async () => {
    expect((await send("POST", "/api/sessions/nowhere/recap", { body: "Hello." })).status).toBe(404);
  });

  it("appends rather than replacing, so two are two", async () => {
    await send("POST", "/api/sessions/umbra-s12/recap", { body: "First." });
    await send("POST", "/api/sessions/umbra-s12/recap", { body: "Second." });

    expect((await sessionLogs(env, "umbra-s12")).map((entry) => entry.body)).toEqual([
      "First.",
      "Second.",
    ]);
    expect(posts).toHaveLength(2);
  });
});
