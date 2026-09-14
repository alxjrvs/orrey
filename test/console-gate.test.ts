import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db, schema } from "../src/db/index.ts";
import { SETTING_KEYS, setSetting } from "../src/db/settings.ts";
import { createApp } from "../src/http/app.ts";
import { issueSession, SESSION_COOKIE } from "../src/console/cookies.ts";
import { sessionFrom } from "../src/console/session.ts";
import { storedTokens } from "../src/console/oauth.ts";

/**
 * The gate, and the rotating pair behind it. The important claim is that a
 * permission is read from Discord with the bot token on every request — so
 * nothing a person holds is ever consulted about what they may do.
 */
const app = createApp();
const realFetch = globalThis.fetch;
const NOW = new Date("2026-09-14T12:00:00Z");
const seconds = Math.floor(NOW.getTime() / 1000);

const ORGANISER_ROLE = "role-organiser";

let calls: { url: string; auth: string | null; body?: Record<string, string> }[] = [];
let memberResponse: () => Response;
let tokenResponse: () => Response;

function consoleEnv() {
  return {
    ...env,
    CONSOLE_SESSION_SECRET: "a-secret",
    DISCORD_APPLICATION_ID: "app-1",
    DISCORD_CLIENT_SECRET: "shh",
    DISCORD_BOT_TOKEN: "bot-token",
  };
}

async function cookieFor(userId: string): Promise<string> {
  return `${SESSION_COOKIE}=${await issueSession(consoleEnv(), userId, NOW)}`;
}

function api(path: string, cookie?: string) {
  return app.fetch(
    new Request(`https://orrey.test${path}`, cookie ? { headers: { cookie } } : {}),
    consoleEnv(),
  );
}

async function seedUser(id: string, expiresAt = seconds + 86_400) {
  await db(env)
    .insert(schema.users)
    .values({ discordId: id, username: `u-${id}`, feedToken: `t-${id}` })
    .onConflictDoNothing();
  await db(env)
    .insert(schema.discordTokens)
    .values({ userId: id, accessToken: "at-old", refreshToken: "rt-old", expiresAt })
    .onConflictDoNothing();
}

beforeEach(async () => {
  calls = [];
  memberResponse = () => Response.json({ roles: [ORGANISER_ROLE], user: { id: "1001" } });
  tokenResponse = () =>
    Response.json({ access_token: "at-new", refresh_token: "rt-new", expires_in: 604_800 });

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const headers = new Headers(init?.headers);
    calls.push({ url, auth: headers.get("authorization") });

    if (url.includes("/oauth2/token")) {
      calls[calls.length - 1]!.body = Object.fromEntries(
        new URLSearchParams(String(init?.body ?? "")),
      );
      return tokenResponse();
    }
    if (url.includes("/members/")) return memberResponse();
    return new Response("unexpected", { status: 500 });
  }) as typeof fetch;

  await env.DB.prepare("DELETE FROM discord_tokens").run();
  await env.DB.prepare("DELETE FROM users").run();
  await env.DB.prepare("DELETE FROM settings").run();
  await setSetting(env, SETTING_KEYS.guildId, "g1");
  await setSetting(env, SETTING_KEYS.organiserRoleId, ORGANISER_ROLE);
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("the gate", () => {
  it("turns away somebody with no cookie at all", async () => {
    const response = await api("/api/me");
    expect(response.status).toBe(401);
    // Nothing was asked of Discord about a person who is not signed in.
    expect(calls).toEqual([]);
  });

  it("turns away a cookie whose token pair is gone", async () => {
    const response = await api("/api/me", await cookieFor("1001"));
    expect(response.status).toBe(401);
  });

  it("lets an organiser through, having asked Discord as the bot", async () => {
    await seedUser("1001");

    const response = await api("/api/me", await cookieFor("1001"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ userId: "1001" });

    const member = calls.find((call) => call.url.includes("/members/"));
    expect(member?.url).toContain("/guilds/g1/members/1001");
    // The bot token, never the user's bearer. This is the invariant.
    expect(member?.auth).toBe("Bot bot-token");
    expect(calls.every((call) => call.auth !== "Bearer at-old")).toBe(true);
  });

  it("answers 403, not a redirect, to somebody without the role", async () => {
    await seedUser("1001");
    memberResponse = () => Response.json({ roles: ["role-someone-else"] });

    const response = await api("/api/me", await cookieFor("1001"));

    // 403 because the caller is fetch from the SPA: a 302 to Discord arrives as
    // an opaque CORS failure rather than as "you are not allowed".
    expect(response.status).toBe(403);
  });

  it("treats somebody who has left the guild as not an organiser", async () => {
    await seedUser("1001");
    memberResponse = () => Response.json({ message: "Unknown Member", code: 10007 }, { status: 404 });

    expect((await api("/api/me", await cookieFor("1001"))).status).toBe(403);
  });

  it("fails closed when the organiser role has not been seeded", async () => {
    await seedUser("1001");
    await env.DB.prepare("DELETE FROM settings WHERE key = ?")
      .bind(SETTING_KEYS.organiserRoleId)
      .run();

    // Nobody being an organiser is wrong in a way somebody notices at once.
    // Everybody being one is wrong in a way nobody notices until it matters.
    const response = await api("/api/me", await cookieFor("1001"));

    // 503, not 403: Orrey does not know which role administers, and saying so
    // beats sending somebody hunting for a permission they already have.
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: expect.stringContaining("discord.organiser_role_id"),
    });
  });

  it("reads the role again on the next request", async () => {
    await seedUser("1001");
    const cookie = await cookieFor("1001");

    expect((await api("/api/me", cookie)).status).toBe(200);
    memberResponse = () => Response.json({ roles: [] });

    // Nothing is cached and nothing is in the cookie, so losing the role in
    // Discord is a permission gone now rather than at the next login.
    expect((await api("/api/me", cookie)).status).toBe(403);
  });
});

describe("the rotating pair", () => {
  it("uses a token that is still good without asking Discord for another", async () => {
    await seedUser("1001", seconds + 86_400);

    const session = await sessionFrom(consoleEnv(), await cookieFor("1001"), NOW);

    expect(session).toMatchObject({ userId: "1001", accessToken: "at-old" });
    expect(calls.filter((call) => call.url.includes("/oauth2/token"))).toEqual([]);
  });

  it("refreshes one that is about to lapse, and keeps the new refresh token", async () => {
    await seedUser("1001", seconds + 10);

    const session = await sessionFrom(consoleEnv(), await cookieFor("1001"), NOW);

    expect(session).toMatchObject({ accessToken: "at-new" });
    const exchange = calls.find((call) => call.url.includes("/oauth2/token"));
    expect(exchange?.body).toMatchObject({
      grant_type: "refresh_token",
      refresh_token: "rt-old",
    });

    // Discord rotates refresh tokens. Keeping the old one is how somebody is
    // logged out for good a week later.
    expect(await storedTokens(env, "1001")).toMatchObject({
      accessToken: "at-new",
      refreshToken: "rt-new",
    });
  });

  it("keeps the cached name through a refresh", async () => {
    await seedUser("1001", seconds + 10);
    await db(env)
      .update(schema.users)
      .set({ globalName: "Ada" })
      .where(eq(schema.users.discordId, "1001"));

    await sessionFrom(consoleEnv(), await cookieFor("1001"), NOW);

    // A refresh knows an id and nothing else about the person; writing them
    // through would blank the cache every time a token was renewed.
    expect(await db(env).select().from(schema.users).get()).toMatchObject({ globalName: "Ada" });
  });

  it("does not log anybody out for losing a race it was always going to lose", async () => {
    await seedUser("1001", seconds + 10);
    const e = consoleEnv();
    const cookie = await cookieFor("1001");

    // The console asks for three things at once, so three requests can reach the
    // refresh holding the same token. Discord rotates it, so the two that arrive
    // second are refused for a token that was good when they read it.
    let first = true;
    tokenResponse = () => {
      if (first) {
        first = false;
        return Response.json({
          access_token: "at-new",
          refresh_token: "rt-new",
          expires_in: 604_800,
        });
      }
      return new Response("invalid_grant", { status: 400 });
    };

    const [a, b, c] = await Promise.all([
      sessionFrom(e, cookie, NOW),
      sessionFrom(e, cookie, NOW),
      sessionFrom(e, cookie, NOW),
    ]);

    // All three are signed in. Before this, two of them blanked the console to
    // "Not signed in" and one of them deleted the winner's fresh pair.
    for (const session of [a, b, c]) {
      expect(session).toMatchObject({ userId: "1001", accessToken: "at-new" });
    }
    expect(await storedTokens(env, "1001")).toMatchObject({ refreshToken: "rt-new" });
  });

  it("logs somebody out when the refresh is refused", async () => {
    await seedUser("1001", seconds + 10);
    tokenResponse = () => new Response("no", { status: 400 });

    const session = await sessionFrom(consoleEnv(), await cookieFor("1001"), NOW);

    // Not an error to retry into: a logged-out person. The pair is dropped so
    // the next request does not ask again with a token Discord has refused.
    expect(session).toBeUndefined();
    expect(await storedTokens(env, "1001")).toBeUndefined();
  });
});

