import { env } from "cloudflare:test";
import { asc } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db, schema } from "../src/db/index.ts";
import { SETTING_KEYS, getSetting, setSetting } from "../src/db/settings.ts";
import { createApp } from "../src/http/app.ts";
import { SESSION_COOKIE, issueSession } from "../src/console/cookies.ts";
import { settingsView } from "../src/console/settings.ts";

/**
 * The settings page.
 *
 * The allow-list is the mechanism, and that is what most of these test. A
 * settings page that writes whatever key it is handed can seed a key the rest of
 * the Worker will never read — an entry that looks like configuration, reads
 * like configuration, and does nothing.
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

function put(key: string, value: unknown) {
  return send("PUT", `/api/settings/${key}`, { value });
}

function audit() {
  return db(env).select().from(schema.auditLog).orderBy(asc(schema.auditLog.createdAt)).all();
}

beforeEach(async () => {
  roles = [ORGANISER_ROLE];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("/members/")) return Response.json({ roles });
    return new Response("unexpected", { status: 500 });
  }) as typeof fetch;

  for (const table of ["audit_log", "discord_tokens", "users", "settings"]) {
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

describe("the allow-list", () => {
  it("refuses a key nothing reads rather than storing it", async () => {
    const res = await put("orrey.vibes", "immaculate");

    expect(res.status).toBe(400);
    // Not stored, not even as a harmless extra row. A settings entry that
    // nothing reads is worse than no page at all.
    expect(await getSetting(env, "orrey.vibes")).toBeUndefined();
    expect(await audit()).toEqual([]);
  });

  it("offers only keys the Worker already reads", async () => {
    const view = await settingsView(env);
    const known = new Set(Object.values(SETTING_KEYS));

    for (const field of view) expect(known.has(field.key as never)).toBe(true);
  });

  it("refuses to re-point the guild from a web form", async () => {
    const res = await put(SETTING_KEYS.guildId, "g2");

    // Every id in the database belongs to the guild it names. This is a
    // migration, and `scripts/adopt-ids.ts` owns it.
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toMatchObject({
      error: expect.stringContaining("adopt-ids"),
    });
    expect(await getSetting(env, SETTING_KEYS.guildId)).toBe("g1");
  });

  it("renders the guild read-only rather than hiding it", async () => {
    const guild = (await settingsView(env)).find((f) => f.key === SETTING_KEYS.guildId);
    expect(guild?.writable).toBe(false);
    expect(guild?.value).toBe("g1");
  });
});

describe("what a value has to be", () => {
  it("takes a reminder ladder that counts down to the session", async () => {
    expect((await put(SETTING_KEYS.reminderStepsHours, [72, 24, 2])).status).toBe(200);
    expect(await getSetting(env, SETTING_KEYS.reminderStepsHours)).toEqual([72, 24, 2]);
  });

  it("refuses one that does not", async () => {
    const res = await put(SETTING_KEYS.reminderStepsHours, [2, 24, 72]);

    // "Hours before the session" only means anything in order. A ladder that is
    // not ordered is one where "the next step" is whichever row was read first.
    expect(res.status).toBe(400);
    expect(await getSetting(env, SETTING_KEYS.reminderStepsHours)).toBeUndefined();
  });

  it("refuses a ladder with a repeated step", async () => {
    expect((await put(SETTING_KEYS.reminderStepsHours, [24, 24])).status).toBe(400);
  });

  it("takes a timezone this runtime knows", async () => {
    expect((await put(SETTING_KEYS.timezone, "Pacific/Auckland")).status).toBe(200);
    expect(await getSetting(env, SETTING_KEYS.timezone)).toBe("Pacific/Auckland");
  });

  it("refuses one it does not", async () => {
    const res = await put(SETTING_KEYS.timezone, "Middle/Earth");

    // Asked of `Intl` rather than matched against a list: a list goes stale the
    // next time a country moves its clocks, and a zone the runtime does not know
    // is one every rendering in the repo would throw on.
    expect(res.status).toBe(400);
    expect(await getSetting(env, SETTING_KEYS.timezone)).toBeUndefined();
  });

  it("refuses a horizon of zero", async () => {
    expect((await put(SETTING_KEYS.horizonSessions, 0)).status).toBe(400);
  });
});

describe("the audit row", () => {
  it("carries the old value and the new one", async () => {
    await setSetting(env, SETTING_KEYS.horizonSessions, 4);

    expect((await put(SETTING_KEYS.horizonSessions, 1)).status).toBe(200);

    const rows = await audit();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: "setting.update",
      targetType: "setting",
      targetId: SETTING_KEYS.horizonSessions,
      actorUserId: "1001",
    });
    // "Somebody changed the horizon" is not an audit trail. "Somebody changed
    // the horizon from 4 to 1" is.
    expect(rows[0]?.detail).toMatchObject({ before: 4, after: 1 });
  });

  it("records null for a key that had never been written", async () => {
    await put(SETTING_KEYS.pollWindowHours, 48);
    expect((await audit())[0]?.detail).toMatchObject({ before: null, after: 48 });
  });
});

describe("what the page says a change costs", () => {
  it("says shrinking the horizon deletes nothing", async () => {
    const horizon = (await settingsView(env)).find((f) => f.key === SETTING_KEYS.horizonSessions);
    expect(horizon?.caveat).toContain("does not delete sessions already materialised");
  });

  it("gives every field its default, so a blank one is not a mystery", async () => {
    const view = await settingsView(env);
    expect(view.find((f) => f.key === SETTING_KEYS.gameDayLockLeadHours)?.fallback).toBe(48);
  });
});

describe("who may", () => {
  it("refuses a write from somebody who is not an organiser", async () => {
    roles = [];
    expect((await put(SETTING_KEYS.pollWindowHours, 48)).status).toBe(403);
    expect(await getSetting(env, SETTING_KEYS.pollWindowHours)).toBeUndefined();
  });

  it("refuses the list to them too", async () => {
    roles = [];
    expect((await send("GET", "/api/settings")).status).toBe(403);
  });
});
