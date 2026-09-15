import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db, schema } from "../src/db/index.ts";
import { SETTING_KEYS, getSetting, setSetting } from "../src/db/settings.ts";
import type { Env, OutboxMessage } from "../src/env.ts";
import { clearTokenCache } from "../src/google/calendar.ts";
import { googleFingerprint, loadProjectionTarget } from "../src/projection/target.ts";
import { applyDeletion } from "../src/google/inbound.ts";
import { act, classifyAll, reconcile } from "../src/google/sync.ts";
import { handleScheduled } from "../src/cron/scheduled.ts";
import type { CalendarEvent } from "../src/google/sync.ts";

/**
 * D1 wins, and the nightly sweep.
 *
 * The two claims: there is no direction in which Google wins — a deletion comes
 * back and never touches `sessions.state` — and a nightly pass over a quiet
 * calendar issues **zero writes**, which is the only thing that makes running it
 * every night affordable, and the only thing that keeps the echo test meaningful.
 */
const realFetch = globalThis.fetch;
const START = Math.floor(Date.parse("2026-09-20T19:00:00Z") / 1000);
const SESSION_ID = "umbra-s12";

let urls: string[] = [];
let replies: { status: number; body: unknown }[] = [];
let sent: OutboxMessage[] = [];

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

function syncEnv(): Env {
  return {
    ...env,
    GOOGLE_CALENDAR_ID: "orrey@group.calendar.google.com",
    GOOGLE_SERVICE_ACCOUNT_EMAIL: "svc@example.iam.gserviceaccount.com",
    GOOGLE_SERVICE_ACCOUNT_KEY: pem,
    OUTBOX: {
      send: async (body: OutboxMessage) => void sent.push(body),
      sendBatch: async (batch: Iterable<{ body: OutboxMessage }>) => {
        for (const { body } of batch) sent.push(body);
      },
    } as unknown as Env["OUTBOX"],
  } as Env;
}

function reply(body: unknown, status = 200) {
  replies.push({ status, body });
}

function event(over: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id: "evt-1",
    status: "confirmed",
    summary: "Age of Umbra — Session 12",
    location: "The Wreck",
    start: { dateTime: new Date(START * 1000).toISOString() },
    end: { dateTime: new Date((START + 4 * 3600) * 1000).toISOString() },
    extendedProperties: { private: { orreySessionId: SESSION_ID } },
    ...over,
  };
}

function sessionRow() {
  return db(env).select().from(schema.sessions).where(eq(schema.sessions.id, SESSION_ID)).get();
}

function linkRow() {
  return db(env)
    .select()
    .from(schema.calendarLinks)
    .where(eq(schema.calendarLinks.sessionId, SESSION_ID))
    .get();
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
  await db(env)
    .insert(schema.sessions)
    .values({
      id: SESSION_ID,
      kind: "campaign_session",
      campaignId: "umbra",
      number: 12,
      startsAt: START,
      endsAt: START + 4 * 3600,
      location: "The Wreck",
      state: "SCHEDULED",
      threadId: "thread-1",
    });
  const target = (await loadProjectionTarget(env, SESSION_ID))!;
  await db(env)
    .insert(schema.calendarLinks)
    .values({
      sessionId: SESSION_ID,
      gcalEventId: "evt-1",
      fingerprint: await googleFingerprint(target),
    });
}

beforeEach(async () => {
  urls = [];
  replies = [];
  sent = [];
  clearTokenCache();

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("oauth2.googleapis.com")) {
      return Response.json({ access_token: "at", expires_in: 3600 });
    }
    // Discord is not what this file is about: a move posts a notice, and the
    // scripted replies below are the calendar's.
    if (url.includes("discord.com")) {
      return Response.json({ id: "msg-1", channel_id: "chan-1" });
    }
    urls.push(url);
    const next = replies.shift();
    if (!next) throw new Error(`no scripted reply for ${url}`);
    return new Response(JSON.stringify(next.body), {
      status: next.status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  for (const table of [
    "audit_log",
    "publications",
    "calendar_links",
    "attendance",
    "jobs",
    "sessions",
    "campaigns",
    "users",
    "settings",
  ]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  await setSetting(env, SETTING_KEYS.guildId, "g1");
  await seed();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  clearTokenCache();
});

describe("an event a human deleted", () => {
  it("comes back at the same id, and the session never changed state", async () => {
    const before = await sessionRow();

    const classified = await classifyAll(env, [event({ status: "cancelled" })]);
    expect(classified[0]?.verdict).toBe("deleted");
    await act(syncEnv(), classified);

    // Clearing the fingerprint is the mechanism: `upsert` skips a write whose
    // fingerprint matches, so without it the re-insert would be skipped and the
    // event would stay gone. The id is minted from the session id, so the
    // re-insert lands on the same event.
    expect((await linkRow())?.fingerprint).toBeNull();
    expect((await linkRow())?.gcalEventId).toBe("evt-1");
    expect(sent).toEqual([{ kind: "gcal.upsert", sessionId: SESSION_ID }]);
    // D1 wins. A deletion on the calendar says nothing about whether the
    // session is happening.
    expect(await sessionRow()).toEqual(before);
  });

  it("cancels nothing, however the event was worded", async () => {
    await applyDeletion(syncEnv(), SESSION_ID);

    expect(await sessionRow()).toMatchObject({ state: "SCHEDULED" });
  });
});

describe("the nightly sweep", () => {
  it("lists the whole calendar rather than what a cursor says changed", async () => {
    await setSetting(syncEnv(), SETTING_KEYS.googleSyncToken, "cursor-held");
    reply({ items: [event()], nextSyncToken: "cursor-next" });

    await reconcile(syncEnv());

    // A reconcile that used the stored cursor would see exactly what the pushes
    // already saw, which is the thing it exists not to depend on.
    expect(urls[0]).not.toContain("syncToken=");
  });

  it("issues zero writes over an untouched calendar", async () => {
    reply({ items: [event()], nextSyncToken: "cursor" });

    await reconcile(syncEnv());

    // Every fingerprint matches, so every verdict is echo. A sweep that
    // rewrote everything every night would make the echo test meaningless and
    // would be too expensive to run.
    expect(sent).toEqual([]);
    expect((await linkRow())?.fingerprint).toEqual(expect.any(String));
  });

  it("leaves somebody else's event alone", async () => {
    reply({
      items: [event(), { id: "their-lunch", summary: "Lunch", status: "confirmed" }],
      nextSyncToken: "cursor",
    });

    await reconcile(syncEnv());

    expect(sent).toEqual([]);
  });

  it("re-inserts a session whose link names an event the calendar does not have", async () => {
    // The failure no push can ever report: a deletion Google never told anybody
    // about produces no notification, so the only way to notice is to look.
    reply({ items: [], nextSyncToken: "cursor" });

    await reconcile(syncEnv());

    expect((await linkRow())?.fingerprint).toBeNull();
    expect(sent).toEqual([{ kind: "gcal.upsert", sessionId: SESSION_ID }]);
    expect(await sessionRow()).toMatchObject({ state: "SCHEDULED" });
  });

  it("puts a dragged event through the same handler the push path uses", async () => {
    reply({
      items: [event({ start: { dateTime: new Date((START + 86_400) * 1000).toISOString() } })],
      nextSyncToken: "cursor",
    });

    await reconcile(syncEnv());

    // Same classifier, same handlers. There is no second interpretation of
    // anything on the nightly path.
    expect(await sessionRow()).toMatchObject({ startsAt: START + 86_400 });
  });

  it("stores the cursor it was given, so the pushes carry on from here", async () => {
    reply({ items: [event()], nextSyncToken: "cursor-fresh" });

    await reconcile(syncEnv());

    expect(await getSetting(syncEnv(), SETTING_KEYS.googleSyncToken)).toBe("cursor-fresh");
  });
});

describe("the tick that calls it", () => {
  it("runs at 05:30 UTC and not at 05:00", async () => {
    reply({ items: [event()], nextSyncToken: "cursor" });

    // 05:00 is the horizon tick, not this one.
    await handleScheduled(
      { scheduledTime: Date.parse("2026-09-20T05:00:00Z") } as ScheduledController,
      syncEnv(),
    );
    expect(urls).toEqual([]);

    await handleScheduled(
      { scheduledTime: Date.parse("2026-09-20T05:30:00Z") } as ScheduledController,
      syncEnv(),
    );
    expect(urls).toHaveLength(1);
  });
});
