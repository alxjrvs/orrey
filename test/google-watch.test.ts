import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SETTING_KEYS, getSetting, setSetting } from "../src/db/settings.ts";
import { clearTokenCache } from "../src/google/calendar.ts";
import { renewWatchIfDue, startWatch, storedWatch, type Watch } from "../src/google/watch.ts";
import { handleScheduled } from "../src/cron/scheduled.ts";

/**
 * Opening a channel and keeping it open.
 *
 * The property this file exists to pin is the **order**: the new channel is
 * recorded before the old one is stopped. Two channels open at once costs a few
 * duplicate pushes, which collapse into one job anyway. A gap costs changes
 * nobody hears about, and nothing in the system would notice.
 */
const realFetch = globalThis.fetch;
const DAY = 86_400;

let calls: { path: string; body: Record<string, unknown> }[] = [];
let opened = 0;

/** A real key, so the service-account JWT is genuinely signed on the way through. */
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

function watchEnv() {
  return {
    ...env,
    PUBLIC_ORIGIN: "https://orrey.test",
    GOOGLE_CALENDAR_ID: "orrey@group.calendar.google.com",
    GOOGLE_SERVICE_ACCOUNT_EMAIL: "svc@example.iam.gserviceaccount.com",
    GOOGLE_SERVICE_ACCOUNT_KEY: pem,
  } as typeof env;
}

beforeEach(async () => {
  calls = [];
  opened = 0;
  clearTokenCache();
  await env.DB.prepare("DELETE FROM settings").run();

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    if (url.hostname === "oauth2.googleapis.com") {
      return Response.json({ access_token: "at", expires_in: 3600 });
    }

    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    calls.push({ path: url.pathname, body });

    if (url.pathname.endsWith("/events/watch")) {
      opened += 1;
      return Response.json({
        resourceId: `resource-${opened}`,
        expiration: String((Math.floor(Date.now() / 1000) + 7 * DAY) * 1000),
      });
    }
    return new Response(null, { status: 204 });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  clearTokenCache();
});

describe("opening one", () => {
  it("watches the Orrey calendar and nothing else", async () => {
    await startWatch(watchEnv());

    const watch = calls.find((call) => call.path.endsWith("/events/watch"));
    expect(watch?.path).toBe(
      "/calendar/v3/calendars/orrey%40group.calendar.google.com/events/watch",
    );
    expect(watch?.body).toMatchObject({
      type: "web_hook",
      address: "https://orrey.test/google/notifications",
    });
  });

  it("records the channel, its resource and its secret", async () => {
    const watch = await startWatch(watchEnv());

    expect(await storedWatch(watchEnv())).toEqual(watch);
    expect(watch.resourceId).toBe("resource-1");
    expect(watch.token).toEqual(expect.any(String));
    expect(watch.token.length).toBeGreaterThan(8);
  });

  it("mints a different secret every time", async () => {
    const first = await startWatch(watchEnv());
    const second = await startWatch(watchEnv());

    expect(second.token).not.toBe(first.token);
    expect(second.channelId).not.toBe(first.channelId);
  });

  it("refuses a channel Google opened without a resource id", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = new URL(typeof input === "string" ? input : (input as Request).url);
      if (url.hostname === "oauth2.googleapis.com") {
        return Response.json({ access_token: "at", expires_in: 3600 });
      }
      return Response.json({ expiration: "1" });
    }) as typeof fetch;

    // There would be nothing to stop it with later, so it is not a channel.
    await expect(startWatch(watchEnv())).rejects.toThrow(/resource id/);
  });
});

describe("replacing one", () => {
  it("records the new channel before stopping the old, in that order", async () => {
    const first = await startWatch(watchEnv());
    calls = [];

    await startWatch(watchEnv());

    // The transcript is the assertion: open, then stop. The write in between is
    // what makes a failed stop harmless.
    expect(calls.map((call) => call.path)).toEqual([
      "/calendar/v3/calendars/orrey%40group.calendar.google.com/events/watch",
      "/calendar/v3/channels/stop",
    ]);
    expect(calls[1]?.body).toMatchObject({
      id: first.channelId,
      resourceId: first.resourceId,
    });
  });

  it("keeps the new channel when Google refuses to stop the old one", async () => {
    await startWatch(watchEnv());
    const failing = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : (input as Request).url);
      if (url.pathname.endsWith("/channels/stop")) {
        return new Response("no", { status: 500 });
      }
      return failing(input, init);
    }) as typeof fetch;

    const second = await startWatch(watchEnv());

    // A channel Google will not close lapses within the week on its own.
    // Throwing here would lose the replacement that is already recorded.
    expect(await storedWatch(watchEnv())).toEqual(second);
  });
});

describe("the renewal window", () => {
  async function store(expiresInSeconds: number) {
    const now = Math.floor(Date.now() / 1000);
    await setSetting(watchEnv(), SETTING_KEYS.googleWatch, {
      channelId: "old",
      resourceId: "old-resource",
      token: "old-token",
      expiresAt: now + expiresInSeconds,
    } satisfies Watch);
    return now;
  }

  it("opens one when there is none", async () => {
    expect(await renewWatchIfDue(watchEnv())).toBe("opened");
    expect(await storedWatch(watchEnv())).toMatchObject({ resourceId: "resource-1" });
  });

  it("leaves a channel with a week left alone", async () => {
    const now = await store(7 * DAY);

    expect(await renewWatchIfDue(watchEnv(), now)).toBe("current");
    expect(calls).toEqual([]);
    expect(await storedWatch(watchEnv())).toMatchObject({ channelId: "old" });
  });

  it("replaces one inside the window", async () => {
    const now = await store(DAY);

    expect(await renewWatchIfDue(watchEnv(), now)).toBe("renewed");
    expect(await storedWatch(watchEnv())).toMatchObject({ resourceId: "resource-1" });
  });

  it("is idempotent when the tick runs twice in a minute", async () => {
    const now = await store(DAY);

    await renewWatchIfDue(watchEnv(), now);
    const after = await storedWatch(watchEnv());
    calls = [];

    // The first run left an expiry a week out, which is outside the window, so
    // the second opens nothing. No lock needed.
    expect(await renewWatchIfDue(watchEnv(), now)).toBe("current");
    expect(calls).toEqual([]);
    expect(await storedWatch(watchEnv())).toEqual(after);
  });
});

describe("the tick that calls it", () => {
  it("runs at 04:00 UTC and not at 04:01", async () => {
    await handleScheduled(
      { scheduledTime: Date.parse("2026-09-20T04:01:00Z") } as ScheduledController,
      watchEnv(),
    );
    expect(await getSetting(watchEnv(), SETTING_KEYS.googleWatch)).toBeUndefined();

    await handleScheduled(
      { scheduledTime: Date.parse("2026-09-20T04:00:00Z") } as ScheduledController,
      watchEnv(),
    );
    expect(await getSetting(watchEnv(), SETTING_KEYS.googleWatch)).toMatchObject({
      resourceId: "resource-1",
    });
  });
});
