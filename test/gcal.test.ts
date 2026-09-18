import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../src/env.ts";
import { db, schema } from "../src/db/index.ts";
import { seedStatements } from "../src/db/seed-sql.ts";
import { clearTokenCache } from "../src/google/calendar.ts";
import { eventIdFor } from "../src/google/event-id.ts";
import { project } from "../src/queue/consumer.ts";
import { find } from "../src/projection/publications.ts";

/**
 * Google, scripted. The token exchange is answered like the real one, so the
 * service-account JWT is genuinely signed on the way through.
 */
interface Call {
  method: string;
  url: string;
  body: Record<string, unknown> | undefined;
}

const realFetch = globalThis.fetch;
let calls: Call[] = [];
let replies: { status: number; body: unknown }[] = [];
let tokens = 0;

function reply(status: number, body: unknown = {}) {
  replies.push({ status, body });
}

async function testKeyPem(): Promise<string> {
  const pair = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const pkcs8 = (await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer;
  const b64 = btoa(String.fromCharCode(...new Uint8Array(pkcs8))).replace(/(.{64})/g, "$1\n");
  return `-----BEGIN PRIVATE KEY-----\n${b64}\n-----END PRIVATE KEY-----\n`;
}

const pem = await testKeyPem();

function googleEnv(over: Partial<Env> = {}): Env {
  return {
    ...env,
    GOOGLE_CALENDAR_ID: "orrey@group.calendar.google.com",
    GOOGLE_SERVICE_ACCOUNT_EMAIL: "orrey@example.iam.gserviceaccount.com",
    GOOGLE_SERVICE_ACCOUNT_KEY: pem,
    ...over,
  } as Env;
}

const campaign = { name: "Age of Umbra", kind: "run", discordChannelId: "c", discordRoleId: "r" } as const;
const session = {
  number: 12,
  startsAt: Date.parse("2026-09-20T19:00:00Z") / 1000,
  endsAt: Date.parse("2026-09-20T23:00:00Z") / 1000,
  location: "The Wreck",
};
const SESSION_ID = "age-of-umbra-s12";
const CALENDAR = encodeURIComponent("orrey@group.calendar.google.com");

async function seed(over: Partial<typeof session> = {}): Promise<void> {
  for (const statement of seedStatements(campaign, { ...session, ...over })) {
    await env.DB.prepare(statement).run();
  }
}

function upsert(e: Env = googleEnv()) {
  return project({ kind: "gcal.upsert", sessionId: SESSION_ID }, e);
}

function link() {
  return db(env).select().from(schema.calendarLinks).get();
}

/** Calls to Google itself, with the token exchange filtered out. */
function apiCalls(): Call[] {
  return calls.filter((call) => !call.url.includes("oauth2.googleapis.com"));
}

beforeEach(async () => {
  calls = [];
  replies = [];
  tokens = 0;
  clearTokenCache();

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({
      method: init?.method ?? "GET",
      url,
      body: init?.body && String(init.body).startsWith("{")
        ? (JSON.parse(String(init.body)) as Record<string, unknown>)
        : undefined,
    });

    if (url.includes("oauth2.googleapis.com")) {
      tokens++;
      return Response.json({ access_token: `token-${tokens}`, expires_in: 3600 });
    }

    const next = replies.shift() ?? { status: 200, body: {} };
    return next.status === 204
      ? new Response(null, { status: 204 })
      : Response.json(next.body, { status: next.status });
  }) as typeof fetch;

  await env.DB.prepare("DELETE FROM publications").run();
  await env.DB.prepare("DELETE FROM calendar_links").run();
  await env.DB.prepare("DELETE FROM jobs").run();
  await env.DB.prepare("DELETE FROM sessions").run();
  await env.DB.prepare("DELETE FROM campaigns").run();
  await seed();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  clearTokenCache();
});

describe("projecting a session to Google", () => {
  it("inserts at an id minted from the session, and records the link", async () => {
    await upsert();

    const call = apiCalls()[0];
    expect(call?.method).toBe("POST");
    expect(call?.url).toBe(`https://www.googleapis.com/calendar/v3/calendars/${CALENDAR}/events`);
    expect(call?.body).toMatchObject({
      id: await eventIdFor(SESSION_ID),
      summary: "Age of Umbra — Session 12",
      location: "The Wreck",
      start: { dateTime: "2026-09-20T19:00:00.000Z", timeZone: "UTC" },
      end: { dateTime: "2026-09-20T23:00:00.000Z", timeZone: "UTC" },
    });

    const stored = await link();
    expect(stored?.gcalEventId).toBe(await eventIdFor(SESSION_ID));
    expect(stored?.fingerprint).toMatch(/^[0-9a-f]{32}$/);
    expect(stored?.syncedAt).toBeGreaterThan(0);
    expect(stored?.lastError).toBeNull();
  });

  it("writes to the Orrey calendar and to no other", async () => {
    await upsert();
    await seed({ startsAt: session.startsAt + 3600 });
    reply(409, { error: { message: "duplicate" } });
    await upsert();

    for (const call of apiCalls()) expect(call.url).toContain(`/calendars/${CALENDAR}/`);
  });

  it("updates in place when the id is already taken — insert, then 409, then PUT", async () => {
    await upsert();
    await seed({ location: "Somewhere else" });
    calls = [];
    reply(409, { error: { message: "The requested identifier already exists." } });

    await upsert();

    const eventId = await eventIdFor(SESSION_ID);
    expect(apiCalls().map((c) => c.method)).toEqual(["POST", "PUT"]);
    expect(apiCalls()[1]?.url).toContain(`/events/${eventId}`);
    expect(apiCalls()[1]?.body).toMatchObject({ location: "Somewhere else" });
  });

  it("skips the write entirely when nothing has changed", async () => {
    await upsert();
    calls = [];

    await upsert();
    await upsert();

    // Google's `updated` moves on every write, and phase 7 has to tell Orrey's
    // own echo from a person's edit — so a pointless write is worse than none.
    expect(apiCalls()).toEqual([]);
  });

  it("carries the session id and fingerprint Google will hand back in phase 7", async () => {
    await upsert();
    const stored = await link();

    expect(apiCalls()[0]?.body?.extendedProperties).toEqual({
      private: { orreySessionId: SESSION_ID, orreyFingerprint: stored?.fingerprint },
    });
  });

  it("records the failure beside the id and still lets the queue retry", async () => {
    reply(500, { error: { message: "Backend error" } });

    await expect(upsert()).rejects.toThrow(/500/);

    const stored = await link();
    expect(stored?.lastError).toMatch(/500/);
    // Nothing was marked synced, so the retry will do the write again.
    expect(stored?.fingerprint).toBeNull();
    expect(stored?.syncedAt).toBeNull();
  });

  it("mints one token and keeps it for the isolate's lifetime", async () => {
    await upsert();
    await seed({ startsAt: session.startsAt + 3600 });
    await upsert();

    expect(tokens).toBe(1);
  });

  it("deletes the event and forgets the link", async () => {
    await upsert();
    reply(204);

    await project({ kind: "gcal.delete", sessionId: SESSION_ID }, googleEnv());

    expect(apiCalls().at(-1)?.method).toBe("DELETE");
    expect(await link()).toBeUndefined();
  });

  it("treats an already-deleted event as deleted", async () => {
    await upsert();
    reply(410, { error: { message: "deleted" } });

    await expect(
      project({ kind: "gcal.delete", sessionId: SESSION_ID }, googleEnv()),
    ).resolves.toBeUndefined();
    expect(await link()).toBeUndefined();
  });

  it("refuses to write when no calendar is configured", async () => {
    await expect(upsert(googleEnv({ GOOGLE_CALENDAR_ID: "" }))).rejects.toThrow(/GOOGLE_CALENDAR_ID/);
    expect(apiCalls()).toEqual([]);
  });
});

describe("the ledger, for events that predate it", () => {
  const ref = { surface: "google", kind: "event", targetId: SESSION_ID } as const;

  it("records a session that was linked before there was a ledger", async () => {
    const eventId = await eventIdFor(SESSION_ID);
    reply(200, {});
    await upsert();

    // Exactly the state of every session at deploy time: a `calendar_links` row
    // with a current fingerprint, and no ledger row at all.
    await env.DB.prepare("DELETE FROM publications").run();
    calls = [];

    await upsert();

    // The write is skippable. The record is not — without it nothing is
    // standing, and a retraction after the session row goes would leave the
    // event on the calendar forever.
    expect(apiCalls()).toEqual([]);
    expect(await find(env, ref)).toMatchObject({ state: "published", remoteId: eventId });
  });

  it("does not resurrect a retraction as a backfill", async () => {
    reply(200, {});
    await upsert();
    reply(204);
    await project({ kind: "gcal.delete", sessionId: SESSION_ID }, googleEnv());

    // A retraction is a decision, not a gap in the ledger.
    expect(await find(env, ref)).toMatchObject({ state: "retracted" });
  });
});
