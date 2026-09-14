import { env } from "cloudflare:test";
import { asc, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db, schema } from "../src/db/index.ts";
import { SETTING_KEYS, setSetting } from "../src/db/settings.ts";
import { createApp } from "../src/http/app.ts";
import { SESSION_COOKIE, issueSession } from "../src/console/cookies.ts";
import { LAG } from "../src/ics/feeds-panel.ts";

/**
 * The feeds panel.
 *
 * The token is a credential, and that is what these test: it never reaches
 * `audit_log`, the rotate takes the old URL out of service immediately, and the
 * panel is the holder's own — read off the session cookie, never off a query
 * string.
 */
const app = createApp();
const realFetch = globalThis.fetch;
const NOW = new Date("2026-09-14T12:00:00Z");
const seconds = Math.floor(NOW.getTime() / 1000);

function consoleEnv() {
  return {
    ...env,
    CONSOLE_SESSION_SECRET: "a-secret",
    DISCORD_APPLICATION_ID: "app-1",
    DISCORD_CLIENT_SECRET: "shh",
    DISCORD_BOT_TOKEN: "bot-token",
  };
}

async function send(method: string, path: string, userId: string | null, origin = "https://orrey.test") {
  return app.fetch(
    new Request(`${origin}${path}`, {
      method,
      headers: userId
        ? { cookie: `${SESSION_COOKIE}=${await issueSession(consoleEnv(), userId, NOW)}` }
        : {},
    }),
    consoleEnv(),
  );
}

async function signedIn(discordId: string, token: string) {
  await db(env)
    .insert(schema.users)
    .values({ discordId, username: discordId, feedToken: token })
    .onConflictDoNothing();
  await db(env)
    .insert(schema.discordTokens)
    .values({ userId: discordId, accessToken: "at", refreshToken: "rt", expiresAt: seconds + 86_400 });
}

function tokenOf(discordId: string) {
  return db(env)
    .select({ feedToken: schema.users.feedToken })
    .from(schema.users)
    .where(eq(schema.users.discordId, discordId))
    .get()
    .then((row) => row?.feedToken);
}

function audit() {
  return db(env).select().from(schema.auditLog).orderBy(asc(schema.auditLog.createdAt)).all();
}

function feed(token: string, path = "all.ics") {
  return app.fetch(new Request(`https://orrey.test/ics/${token}/${path}`), env as never);
}

beforeEach(async () => {
  globalThis.fetch = (async () => new Response("unexpected", { status: 500 })) as typeof fetch;

  for (const table of [
    "audit_log",
    "campaign_members",
    "sessions",
    "campaigns",
    "discord_tokens",
    "users",
    "settings",
  ]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  await setSetting(env, SETTING_KEYS.guildId, "g1");
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("the panel", () => {
  it("offers everything and one URL per campaign the holder is on", async () => {
    await signedIn("ada", "tok-ada");
    await db(env)
      .insert(schema.campaigns)
      .values({ id: "umbra", name: "Age of Umbra", kind: "run", state: "RUNNING" });
    await db(env).insert(schema.campaignMembers).values({ campaignId: "umbra", userId: "ada" });

    const body = (await (await send("GET", "/console/me/feeds", "ada")).json()) as {
      links: { label: string; url: string }[];
    };

    expect(body.links.map((link) => link.label)).toEqual(["Everything", "Age of Umbra"]);
    expect(body.links[0]?.url).toBe("https://orrey.test/ics/tok-ada/all.ics");
    expect(body.links[1]?.url).toBe("https://orrey.test/ics/tok-ada/campaign/umbra.ics");
  });

  it("builds the URLs from the request origin, not from a hardcoded host", async () => {
    await signedIn("ada", "tok-ada");

    const body = (await (
      await send("GET", "/console/me/feeds", "ada", "https://orrey.example.dev")
    ).json()) as { links: { url: string }[] };

    // A hardcoded host is wrong on every environment but one, and the person
    // copying the URL has no way to tell.
    expect(body.links[0]?.url).toBe("https://orrey.example.dev/ics/tok-ada/all.ics");
  });

  it("carries the lag, on the panel rather than in a tooltip", async () => {
    await signedIn("ada", "tok-ada");

    const body = (await (await send("GET", "/console/me/feeds", "ada")).json()) as { lag: string };

    // Somebody who does not know a subscribed feed refreshes overnight reads a
    // correct feed as a broken one.
    expect(body.lag).toBe(LAG);
    expect(body.lag).toContain("eight to twenty-four hours");
  });

  it("is the holder's own, read off the cookie and never off a query string", async () => {
    await signedIn("ada", "tok-ada");
    await signedIn("bea", "tok-bea");

    const body = (await (
      await send("GET", "/console/me/feeds?userId=bea", "ada")
    ).json()) as { links: { url: string }[] };

    expect(body.links[0]?.url).toContain("tok-ada");
    expect(body.links[0]?.url).not.toContain("tok-bea");
  });

  it("refuses without a session", async () => {
    await signedIn("ada", "tok-ada");
    expect((await send("GET", "/console/me/feeds", null)).status).toBe(401);
  });
});

describe("rotating it", () => {
  it("mints a new token and takes the old URL out of service", async () => {
    await signedIn("ada", "tok-ada");
    expect((await feed("tok-ada")).status).toBe(200);

    const res = await send("POST", "/console/me/feeds/rotate", "ada");
    const body = (await res.json()) as { links: { url: string }[] };

    const fresh = await tokenOf("ada");
    expect(fresh).not.toBe("tok-ada");
    expect(body.links[0]?.url).toContain(fresh as string);

    // Immediately, because `p6/15`'s lookup is a single `where feed_token = ?`.
    // Every subscribed client has to be re-pointed by hand, which is why the
    // panel says so before the click.
    expect((await feed("tok-ada")).status).toBe(404);
    expect((await feed(fresh as string)).status).toBe(200);
  });

  it("changes nobody else's token", async () => {
    await signedIn("ada", "tok-ada");
    await signedIn("bea", "tok-bea");

    await send("POST", "/console/me/feeds/rotate", "ada");

    expect(await tokenOf("bea")).toBe("tok-bea");
    expect((await feed("tok-bea")).status).toBe(200);
  });

  it("records that a token was rotated and never what it became", async () => {
    await signedIn("ada", "tok-ada");

    await send("POST", "/console/me/feeds/rotate", "ada");
    const fresh = await tokenOf("ada");

    const rows = await audit();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: "feed.rotate", targetType: "user", targetId: "ada" });

    // Neither the old token nor the new one. An audit log holding a credential
    // is a credential store with a retention policy nobody wrote.
    const written = JSON.stringify(rows[0]);
    expect(written).not.toContain("tok-ada");
    expect(written).not.toContain(fresh as string);
  });

  it("refuses without a session, and rotates nothing", async () => {
    await signedIn("ada", "tok-ada");

    expect((await send("POST", "/console/me/feeds/rotate", null)).status).toBe(401);
    expect(await tokenOf("ada")).toBe("tok-ada");
    expect(await audit()).toEqual([]);
  });
});
