import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db, schema } from "../src/db/index.ts";
import { SETTING_KEYS, setSetting } from "../src/db/settings.ts";
import { mintId } from "../src/db/ids.ts";
import { drainJobs } from "../src/jobs/drain.ts";
import { find } from "../src/projection/publications.ts";
import { postPollPost } from "../src/polls/post.ts";

/**
 * Sent once, from a job. Two posts means two live selects, and the answers split
 * between them with nothing able to say which counted — so "once" is the whole
 * test.
 */
const realFetch = globalThis.fetch;
const POLL = "pollid123456";
const START = Date.parse("2026-10-01T19:00:00Z") / 1000;

let calls: { path: string; body: Record<string, unknown> }[] = [];
let response: () => Response;

const ref = { surface: "discord", kind: "message", targetId: POLL, label: "poll" } as const;

async function poll(over: Partial<typeof schema.datePolls.$inferInsert> = {}) {
  await db(env)
    .insert(schema.datePolls)
    .values({ id: POLL, discordChannelId: "chan-1", campaignId: "age-of-umbra", ...over });
  for (let i = 0; i < 3; i++) {
    await db(env)
      .insert(schema.pollDates)
      .values({
        id: mintId(),
        pollId: POLL,
        startsAt: START + i * 86_400,
        endsAt: START + i * 86_400 + 14_400,
      });
  }
}

function armPost(pollId = POLL) {
  return db(env)
    .insert(schema.jobs)
    .values({
      id: `poll.post:${pollId}`,
      kind: "poll.post",
      payload: { pollId },
      idempotencyKey: `poll.post:${pollId}`,
      runAt: Math.floor(Date.now() / 1000) - 1,
    });
}

function pollRow() {
  return db(env).select().from(schema.datePolls).where(eq(schema.datePolls.id, POLL)).get();
}

function jobRow(pollId = POLL) {
  return db(env).select().from(schema.jobs).where(eq(schema.jobs.id, `poll.post:${pollId}`)).get();
}

beforeEach(async () => {
  calls = [];
  response = () => Response.json({ id: "msg-1", channel_id: "chan-1" });

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    calls.push({
      path: url.pathname.replace("/api/v10", ""),
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
    });
    return response();
  }) as typeof fetch;

  for (const table of [
    "publications",
    "poll_responses",
    "poll_dates",
    "date_polls",
    "jobs",
    "sessions",
    "campaigns",
    "users",
    "settings",
  ]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  await setSetting(env, SETTING_KEYS.guildId, "g1");
  await db(env)
    .insert(schema.campaigns)
    .values({ id: "age-of-umbra", name: "Age of Umbra", kind: "run", state: "RUNNING" });
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("the job", () => {
  it("sends one message and stores its id", async () => {
    await poll();
    await armPost();

    await drainJobs(env);

    expect(calls).toMatchObject([{ path: "/channels/chan-1/messages" }]);
    expect(calls[0]?.body).toMatchObject({ content: expect.stringContaining("Which days work?") });
    expect(await pollRow()).toMatchObject({ discordMessageId: "msg-1" });
    expect((await jobRow())?.state).toBe("done");
  });

  it("sends nothing on a re-run", async () => {
    await poll();
    await armPost();
    await drainJobs(env);
    calls = [];

    // The same standing job row, re-armed — which is what a redelivery or a
    // re-seed looks like.
    await db(env)
      .update(schema.jobs)
      .set({ state: "pending", attempts: 0 })
      .where(eq(schema.jobs.id, `poll.post:${POLL}`));
    await drainJobs(env);

    // A second post is a second live select. Under send-only the first cannot be
    // taken back, and the answers would split between them.
    expect(calls).toEqual([]);
  });

  it("acks a job for a poll that is gone", async () => {
    await armPost("no-such-poll");

    await drainJobs(env);

    expect(calls).toEqual([]);
    expect((await jobRow("no-such-poll"))?.state).toBe("done");
  });

  it("takes the channel from the poll, not from a constant", async () => {
    await setSetting(env, SETTING_KEYS.schedulingChannelId, "the-wrong-channel");
    await poll({ discordChannelId: "chan-other" });
    await armPost();

    await drainJobs(env);

    expect(calls).toMatchObject([{ path: "/channels/chan-other/messages" }]);
  });
});

describe("posting once", () => {
  it("heals from the ledger when only the poll write was lost", async () => {
    await poll();
    await postPollPost(env, POLL);
    await db(env)
      .update(schema.datePolls)
      .set({ discordMessageId: null })
      .where(eq(schema.datePolls.id, POLL));
    calls = [];

    expect(await postPollPost(env, POLL)).toBe("msg-1");
    expect(calls).toEqual([]);
    expect(await pollRow()).toMatchObject({ discordMessageId: "msg-1" });
  });

  it("lets the next attempt post when Discord refused this one", async () => {
    await poll();
    response = () => Response.json({ code: 50001, message: "Missing Access" }, { status: 403 });

    await expect(postPollPost(env, POLL)).rejects.toThrow();

    // Discord read the request and declined it, so nothing went up and the claim
    // must not block a retry.
    expect(await find(env, ref)).toBeUndefined();

    response = () => Response.json({ id: "msg-later", channel_id: "chan-1" });
    expect(await postPollPost(env, POLL)).toBe("msg-later");
  });

  it("holds the claim when it never heard back", async () => {
    await poll();
    response = () => {
      throw new TypeError("network error");
    };

    await expect(postPollPost(env, POLL)).rejects.toThrow();

    // Not hearing a clear no is not the same as it not having happened.
    expect(await find(env, ref)).toMatchObject({ state: "claimed", remoteId: null });
    expect(calls).toHaveLength(1);
  });

  it("holds the claim on a 500, which is the subtle one", async () => {
    await poll();
    response = () => Response.json({ message: "Internal Server Error" }, { status: 500 });

    await expect(postPollPost(env, POLL)).rejects.toThrow();

    // Discord answering 500 does not mean it did not create the message first.
    expect(await find(env, ref)).toMatchObject({ state: "claimed", remoteId: null });
  });

  it("does not share a row with the session's attendance post", async () => {
    await poll();
    await postPollPost(env, POLL);

    // The poll's id is labelled. Nothing that existed before polls did has moved.
    expect(
      await find(env, { surface: "discord", kind: "message", targetId: POLL }),
    ).toBeUndefined();
    expect(await find(env, ref)).toMatchObject({ state: "published", remoteId: "msg-1" });
  });
});
