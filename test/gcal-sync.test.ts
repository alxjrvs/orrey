import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db, schema } from "../src/db/index.ts";
import { SETTING_KEYS, getSetting, setSetting } from "../src/db/settings.ts";
import { clearTokenCache } from "../src/google/calendar.ts";
import { listCalendar, runSync } from "../src/google/sync.ts";
import { drainJobs } from "../src/jobs/drain.ts";

/**
 * Asking Google what is on the calendar.
 *
 * Two things this file pins. The cursor is stored only when the last page
 * arrives, because storing one mid-pagination skips everything not yet read. And
 * the request carries none of the three parameters `syncToken` is incompatible
 * with — that incompatibility is why Orrey owns a calendar at all, and a filter
 * creeping in here would take the whole argument with it.
 */
const realFetch = globalThis.fetch;

let urls: string[] = [];
let replies: { status: number; body: unknown }[] = [];

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

function syncEnv() {
  return {
    ...env,
    GOOGLE_CALENDAR_ID: "orrey@group.calendar.google.com",
    GOOGLE_SERVICE_ACCOUNT_EMAIL: "svc@example.iam.gserviceaccount.com",
    GOOGLE_SERVICE_ACCOUNT_KEY: pem,
  } as typeof env;
}

function reply(body: unknown, status = 200) {
  replies.push({ status, body });
}

function event(id: string) {
  return { id, summary: id, status: "confirmed" };
}

beforeEach(async () => {
  urls = [];
  replies = [];
  clearTokenCache();
  await env.DB.prepare("DELETE FROM settings").run();
  await env.DB.prepare("DELETE FROM jobs").run();

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("oauth2.googleapis.com")) {
      return Response.json({ access_token: "at", expires_in: 3600 });
    }
    urls.push(url);
    const next = replies.shift();
    if (!next) throw new Error(`no scripted reply for ${url}`);
    return new Response(JSON.stringify(next.body), {
      status: next.status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  clearTokenCache();
});

describe("paging", () => {
  it("collects three pages into one list", async () => {
    reply({ items: [event("a")], nextPageToken: "p2" });
    reply({ items: [event("b")], nextPageToken: "p3" });
    reply({ items: [event("c")], nextSyncToken: "cursor-final" });

    const listing = await listCalendar(syncEnv());

    expect(listing.events.map((e) => e.id)).toEqual(["a", "b", "c"]);
    expect(urls).toHaveLength(3);
  });

  it("stores only the cursor the last page carried", async () => {
    reply({ items: [], nextPageToken: "p2" });
    reply({ items: [], nextSyncToken: "cursor-final" });

    await listCalendar(syncEnv());

    // A cursor stored mid-pagination would skip everything on the pages not yet
    // read, and nothing would ever notice.
    expect(await getSetting(syncEnv(), SETTING_KEYS.googleSyncToken)).toBe("cursor-final");
  });

  it("sends the cursor it holds on the next run", async () => {
    await setSetting(syncEnv(), SETTING_KEYS.googleSyncToken, "cursor-held");
    reply({ items: [], nextSyncToken: "cursor-next" });

    await listCalendar(syncEnv());

    expect(urls[0]).toContain("syncToken=cursor-held");
  });

  it("lists fully and stores a cursor when it holds none", async () => {
    reply({ items: [event("a")], nextSyncToken: "cursor-first" });

    const listing = await listCalendar(syncEnv());

    expect(urls[0]).not.toContain("syncToken=");
    expect(listing.full).toBe(true);
    expect(await getSetting(syncEnv(), SETTING_KEYS.googleSyncToken)).toBe("cursor-first");
  });
});

describe("the parameters it must never send", () => {
  it("carries no timeMin, no q and no privateExtendedProperty", async () => {
    reply({ items: [], nextSyncToken: "cursor" });

    await listCalendar(syncEnv());

    // `syncToken` is incompatible with all three. That incompatibility is why
    // Orrey owns a calendar rather than filtering somebody else's.
    expect(urls[0]).not.toContain("timeMin");
    expect(urls[0]).not.toContain("q=");
    expect(urls[0]).not.toContain("privateExtendedProperty");
  });

  it("asks for deleted events, or a deletion looks like nothing at all", async () => {
    reply({ items: [], nextSyncToken: "cursor" });

    await listCalendar(syncEnv());

    expect(urls[0]).toContain("showDeleted=true");
  });

  it("lists the Orrey calendar and nothing else", async () => {
    reply({ items: [], nextSyncToken: "cursor" });

    await listCalendar(syncEnv());

    expect(urls[0]).toContain("/calendars/orrey%40group.calendar.google.com/events");
  });
});

describe("a cursor Google has expired", () => {
  it("clears it and re-lists from scratch in the same call", async () => {
    await setSetting(syncEnv(), SETTING_KEYS.googleSyncToken, "stale");
    reply({ error: "gone" }, 410);
    reply({ items: [event("a"), event("b")], nextSyncToken: "cursor-fresh" });

    const listing = await listCalendar(syncEnv());

    // A sync that answered "410" and stopped would need a second push to
    // recover, and the push that would have caused one has already been
    // collapsed away by the minute key.
    expect(listing.events.map((e) => e.id)).toEqual(["a", "b"]);
    expect(listing.full).toBe(true);
    expect(urls[1]).not.toContain("syncToken=");
    expect(await getSetting(syncEnv(), SETTING_KEYS.googleSyncToken)).toBe("cursor-fresh");
  });

  it("lets any other refusal through", async () => {
    reply({ error: "no" }, 403);

    await expect(listCalendar(syncEnv())).rejects.toThrow(/403/);
  });
});

describe("the job", () => {
  it("drains without touching any other table", async () => {
    reply({ items: [event("a")], nextSyncToken: "cursor" });
    await db(env)
      .insert(schema.jobs)
      .values({
        id: "gcal.sync:1",
        kind: "gcal.sync",
        payload: { minute: 1 },
        idempotencyKey: "gcal.sync:1",
        runAt: 1,
      });

    await drainJobs(syncEnv());

    const [job] = await db(env).select().from(schema.jobs).all();
    expect(job).toMatchObject({ state: "done", lastError: null });
    // This PR knows how to ask and nothing about what the answer means.
    expect(await db(env).select().from(schema.sessions).all()).toEqual([]);
    expect(await db(env).select().from(schema.calendarLinks).all()).toEqual([]);
  });

  it("asks once per run", async () => {
    reply({ items: [], nextSyncToken: "cursor" });

    await runSync(syncEnv());

    expect(urls).toHaveLength(1);
  });
});
