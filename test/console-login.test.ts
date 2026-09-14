import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db, schema } from "../src/db/index.ts";
import { createApp } from "../src/http/app.ts";
import {
  SESSION_COOKIE,
  STATE_COOKIE,
  issueSession,
  readCookie,
  readSession,
} from "../src/console/cookies.ts";
import { SCOPE, storedTokens } from "../src/console/oauth.ts";

/**
 * Discord is the only identity system, and this is the file where that could
 * quietly stop being true. The scope test is the important one: `identify` and
 * nothing else, because the cheapest way to guarantee roles never come from the
 * user's token is never to have asked for them.
 */
const app = createApp();
const realFetch = globalThis.fetch;

const NOW = new Date("2026-09-14T12:00:00Z");

let tokenResponse: () => Response;
let meResponse: () => Response;
let tokenRequests: { url: string; body: Record<string, string> }[] = [];

function consoleEnv() {
  return { ...env, CONSOLE_SESSION_SECRET: "a-secret", DISCORD_APPLICATION_ID: "app-1", DISCORD_CLIENT_SECRET: "shh" };
}

function get(path: string, cookie?: string) {
  return app.fetch(
    new Request(`https://orrey.test${path}`, {
      redirect: "manual",
      ...(cookie ? { headers: { cookie } } : {}),
    }),
    consoleEnv(),
  );
}

beforeEach(async () => {
  tokenRequests = [];
  tokenResponse = () =>
    Response.json({ access_token: "at-1", refresh_token: "rt-1", expires_in: 604_800 });
  meResponse = () => Response.json({ id: "1001", username: "ada", global_name: "Ada" });

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("/oauth2/token")) {
      tokenRequests.push({
        url,
        body: Object.fromEntries(new URLSearchParams(String(init?.body ?? ""))),
      });
      return tokenResponse();
    }
    if (url.includes("/users/@me")) return meResponse();
    return new Response("unexpected", { status: 500 });
  }) as typeof fetch;

  await env.DB.prepare("DELETE FROM discord_tokens").run();
  await env.DB.prepare("DELETE FROM users").run();
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("the authorize redirect", () => {
  it("asks for identify and nothing else", async () => {
    const response = await get("/console/login");
    expect(response.status).toBe(302);

    const location = new URL(response.headers.get("location")!);
    expect(location.origin + location.pathname).toBe("https://discord.com/oauth2/authorize");
    expect(location.searchParams.get("scope")).toBe(SCOPE);
    expect(SCOPE).toBe("identify");
    // The invariant, checked the bluntest way there is.
    expect(response.headers.get("location")).not.toContain("guilds");
    expect(location.searchParams.get("response_type")).toBe("code");
    expect(location.searchParams.get("redirect_uri")).toBe("https://orrey.test/console/callback");
  });

  it("mints a state and remembers it in a cookie of its own", async () => {
    const response = await get("/console/login");
    const state = new URL(response.headers.get("location")!).searchParams.get("state");
    const cookie = response.headers.get("set-cookie") ?? "";

    expect(state).toMatch(/^[0-9a-f]{32}$/);
    expect(readCookie(cookie.split(";")[0], STATE_COOKIE)).toBe(state);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Lax");
  });

  it("mints a different state every time", async () => {
    const one = new URL((await get("/console/login")).headers.get("location")!);
    const two = new URL((await get("/console/login")).headers.get("location")!);
    expect(one.searchParams.get("state")).not.toBe(two.searchParams.get("state"));
  });
});

describe("the callback", () => {
  it("refuses a state that does not match, without exchanging anything", async () => {
    const response = await get("/console/callback?code=c1&state=theirs", `${STATE_COOKIE}=ours`);

    expect(response.status).toBe(400);
    // The code is worth nothing until the state has checked out.
    expect(tokenRequests).toEqual([]);
  });

  it("refuses a callback with no state cookie at all", async () => {
    const response = await get("/console/callback?code=c1&state=theirs");
    expect(response.status).toBe(400);
    expect(tokenRequests).toEqual([]);
  });

  it("exchanges the code, stores the pair, and sets a session", async () => {
    const response = await get("/console/callback?code=c1&state=s1", `${STATE_COOKIE}=s1`);

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/console");
    expect(tokenRequests[0]?.body).toMatchObject({
      grant_type: "authorization_code",
      code: "c1",
      client_id: "app-1",
      client_secret: "shh",
      redirect_uri: "https://orrey.test/console/callback",
    });
    // No PKCE: Orrey is a confidential client and Discord's acceptance of a
    // verifier is undocumented.
    expect(tokenRequests[0]?.body).not.toHaveProperty("code_verifier");

    expect(await storedTokens(env, "1001")).toMatchObject({
      accessToken: "at-1",
      refreshToken: "rt-1",
    });
    // The names are a cache, refreshed by every sighting.
    expect(await db(env).select().from(schema.users).get()).toMatchObject({
      discordId: "1001",
      globalName: "Ada",
    });

    const cookies = response.headers.getSetCookie();
    const session = cookies.find((line) => line.startsWith(`${SESSION_COOKIE}=`));
    expect(session).toContain("HttpOnly");
    expect(session).toContain("Secure");
    expect(session).toContain("SameSite=Lax");
    expect(session).toContain("Path=/");
  });

  it("says so plainly when Discord refuses the exchange", async () => {
    tokenResponse = () => new Response("nope", { status: 401 });
    const response = await get("/console/callback?code=c1&state=s1", `${STATE_COOKIE}=s1`);

    expect(response.status).toBe(502);
    expect(await storedTokens(env, "1001")).toBeUndefined();
  });
});

describe("the session cookie", () => {
  it("round-trips the person who logged in", async () => {
    const e = consoleEnv();
    const cookie = await issueSession(e, "1001", NOW);
    expect(await readSession(e, cookie, NOW)).toBe("1001");
  });

  it("refuses one that has been edited", async () => {
    const e = consoleEnv();
    const cookie = await issueSession(e, "1001", NOW);
    const tampered = cookie.replace("1001", "9999");

    // Not "wrong user" — undefined. A tampered cookie, an expired one and a
    // missing one are all "not logged in".
    expect(await readSession(e, tampered, NOW)).toBeUndefined();
  });

  it("refuses one signed with a different secret", async () => {
    const cookie = await issueSession(consoleEnv(), "1001", NOW);
    const elsewhere = { ...consoleEnv(), CONSOLE_SESSION_SECRET: "another-secret" };
    expect(await readSession(elsewhere, cookie, NOW)).toBeUndefined();
  });

  it("refuses one that has expired", async () => {
    const e = consoleEnv();
    const cookie = await issueSession(e, "1001", NOW);
    const nextMonth = new Date(NOW.getTime() + 30 * 86_400_000);
    expect(await readSession(e, cookie, nextMonth)).toBeUndefined();
  });

  it("refuses nonsense without throwing", async () => {
    const e = consoleEnv();
    for (const cookie of ["", "x", "a.b", "1001.9999999999.zz", "1001.9999999999." + "0".repeat(64)]) {
      expect(await readSession(e, cookie, NOW)).toBeUndefined();
    }
  });
});
