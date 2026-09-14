import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { db, schema } from "../src/db/index.ts";
import { SETTING_KEYS, setSetting } from "../src/db/settings.ts";
import { createApp } from "../src/http/app.ts";
import { SYNC_JOB } from "../src/google/sync.ts";
import type { Watch } from "../src/google/watch.ts";

/**
 * The push, received.
 *
 * Two claims worth pinning. The body is never read — Google's push has none, and
 * the day it does it is still a signal rather than data. And nothing here
 * reaches Google, so a flood of pushes costs one D1 insert each and cannot
 * become a flood of API calls.
 */
const app = createApp();

const WATCH: Watch = {
  channelId: "channel-1",
  resourceId: "resource-1",
  token: "shared-secret",
  expiresAt: Math.floor(Date.now() / 1000) + 7 * 86_400,
};

function push(headers: Record<string, string>, body?: string) {
  return app.fetch(
    new Request("https://orrey.test/google/notifications", {
      method: "POST",
      headers,
      ...(body === undefined ? {} : { body }),
    }),
    env,
  );
}

function good(over: Record<string, string> = {}) {
  return {
    "x-goog-channel-id": WATCH.channelId,
    "x-goog-channel-token": WATCH.token,
    "x-goog-resource-state": "exists",
    ...over,
  };
}

function jobs() {
  return db(env).select().from(schema.jobs).all();
}

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM jobs").run();
  await env.DB.prepare("DELETE FROM settings").run();
  await setSetting(env, SETTING_KEYS.googleWatch, WATCH);
});

describe("what it refuses", () => {
  it("answers 404 to a wrong token, and arms nothing", async () => {
    const res = await push(good({ "x-goog-channel-token": "guessed" }));

    // 404 rather than 401: a 401 confirms the channel exists to whoever guessed
    // the URL.
    expect(res.status).toBe(404);
    expect(await jobs()).toEqual([]);
  });

  it("answers 404 to a missing channel id", async () => {
    const headers = good();
    delete (headers as Record<string, string>)["x-goog-channel-id"];

    expect((await push(headers)).status).toBe(404);
    expect(await jobs()).toEqual([]);
  });

  it("answers 404 to a channel that is not the one on record", async () => {
    expect((await push(good({ "x-goog-channel-id": "somebody-elses" }))).status).toBe(404);
    expect(await jobs()).toEqual([]);
  });

  it("answers 404 when no channel has ever been opened", async () => {
    await env.DB.prepare("DELETE FROM settings").run();

    expect((await push(good())).status).toBe(404);
    expect(await jobs()).toEqual([]);
  });
});

describe("what it does", () => {
  it("acks the handshake and arms nothing", async () => {
    // The `sync` state is what Google sends when a channel opens. Syncing on it
    // would list the whole calendar every time a channel is renewed.
    const res = await push(good({ "x-goog-resource-state": "sync" }));

    expect(res.status).toBe(200);
    expect(await jobs()).toEqual([]);
  });

  it("arms one sync and answers immediately", async () => {
    const res = await push(good());

    expect(res.status).toBe(200);
    expect(await jobs()).toMatchObject([{ kind: SYNC_JOB, state: "pending" }]);
  });

  it("collapses a burst into one sync", async () => {
    // One drag in Google produces a handful of pushes. The unique constraint on
    // the idempotency key is what makes them one job, not a lock.
    await Promise.all(Array.from({ length: 10 }, () => push(good())));

    expect(await jobs()).toHaveLength(1);
  });

  it("never reads the body", async () => {
    // Whatever arrives in a request anybody can send is not the source of truth
    // for what changed. The list call is.
    const res = await push(good(), "not json at all {{{");

    expect(res.status).toBe(200);
    expect(await jobs()).toHaveLength(1);
  });

  it("is matched before the asset fallback", async () => {
    // Registered below `app.all("*")` this would be a 404 served from `public/`.
    expect((await push(good())).status).toBe(200);
  });
});

describe("the route reaches nothing", () => {
  it("makes no outbound call, however many pushes arrive", async () => {
    const realFetch = globalThis.fetch;
    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calls.push(String(typeof input === "string" ? input : (input as Request).url));
      return new Response(null, { status: 500 });
    }) as typeof fetch;

    try {
      await Promise.all(Array.from({ length: 10 }, () => push(good())));
    } finally {
      globalThis.fetch = realFetch;
    }

    // Ten pushes, ten D1 inserts that collapse into one job, and nothing
    // outbound. A flood of pushes cannot become a flood of API calls: the job
    // the drain runs is rate-limited by the minute key, not by this route.
    expect(calls).toEqual([]);
    expect(await jobs()).toHaveLength(1);
  });
});
