import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db, schema } from "../src/db/index.ts";
import { SETTING_KEYS, setSetting } from "../src/db/settings.ts";
import { mintId } from "../src/db/ids.ts";
import { drainJobs } from "../src/jobs/drain.ts";
import { createApp } from "../src/http/app.ts";
import { InteractionResponseType, InteractionType } from "../src/discord/types.ts";
import { encodeCustomId } from "../src/discord/custom-id.ts";
import { fakeDiscord } from "./discord.ts";
import { armPollClose } from "../src/polls/schedule.ts";

/**
 * A notice, and a post that stops answering. The second half is the interesting
 * one: the poll post is still sitting there with a live select and Orrey cannot
 * disarm it, so the handler is where closing is enforced.
 */
const realFetch = globalThis.fetch;
const discord = await fakeDiscord();
const app = createApp();
const POLL = "pollid123456";
const START = Date.parse("2026-10-01T19:00:00Z") / 1000;
const NOW = Math.floor(Date.now() / 1000);

let calls: { path: string; body: Record<string, unknown> }[] = [];
let dates: string[] = [];

async function seed(over: Partial<typeof schema.datePolls.$inferInsert> = {}) {
  await db(env)
    .insert(schema.campaigns)
    .values({ id: "age-of-umbra", name: "Age of Umbra", kind: "run", state: "RUNNING" });
  await db(env)
    .insert(schema.datePolls)
    .values({
      id: POLL,
      campaignId: "age-of-umbra",
      discordChannelId: "chan-1",
      openedBy: "opener",
      ...over,
    });
  dates = [];
  for (let i = 0; i < 2; i++) {
    const id = mintId();
    await db(env)
      .insert(schema.pollDates)
      .values({ id, pollId: POLL, startsAt: START + i * 86_400, endsAt: START + i * 86_400 + 3600 });
    dates.push(id);
  }
}

function click(arg: string, values?: string[], userId = "ada") {
  return discord.request({
    type: InteractionType.MESSAGE_COMPONENT,
    data: {
      custom_id: encodeCustomId({ action: "poll", arg, target: POLL }),
      component_type: values ? 3 : 2,
      ...(values ? { values } : {}),
    },
    member: { user: { id: userId, username: userId, global_name: null }, roles: [] },
    guild_id: "g",
    message: { id: "msg-1", channel_id: "chan-1" },
  });
}

function answers() {
  return db(env).select().from(schema.pollResponses).all();
}

function closeJob() {
  return db(env)
    .select()
    .from(schema.jobs)
    .where(eq(schema.jobs.id, `poll.close:${POLL}`))
    .get();
}

beforeEach(async () => {
  calls = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    calls.push({
      path: url.pathname.replace("/api/v10", ""),
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
    });
    return Response.json({ id: `msg-${calls.length}`, channel_id: "chan-1" });
  }) as typeof fetch;

  for (const table of [
    "publications",
    "poll_responses",
    "poll_dates",
    "date_polls",
    "jobs",
    "campaigns",
    "users",
    "settings",
  ]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  await setSetting(env, SETTING_KEYS.guildId, "g1");
  await db(env)
    .insert(schema.users)
    .values({ discordId: "opener", username: "opener", feedToken: "t-opener" });
  await seed();
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("arming the close", () => {
  it("puts one standing job at the deadline, and records it on the poll", async () => {
    await armPollClose(env, POLL, START - 86_400);

    expect(await closeJob()).toMatchObject({
      kind: "poll.close",
      state: "pending",
      runAt: START - 86_400,
    });
    expect(
      await db(env).select().from(schema.datePolls).where(eq(schema.datePolls.id, POLL)).get(),
    ).toMatchObject({ closesAt: START - 86_400 });
  });

  it("moves rather than making a second one, and un-fails a failed check", async () => {
    await armPollClose(env, POLL, START - 86_400);
    await db(env)
      .update(schema.jobs)
      .set({ state: "failed", attempts: 3, lastError: "something" })
      .where(eq(schema.jobs.id, `poll.close:${POLL}`));

    await armPollClose(env, POLL, START - 3600);

    expect(await db(env).select().from(schema.jobs).all()).toHaveLength(1);
    expect(await closeJob()).toMatchObject({
      runAt: START - 3600,
      state: "pending",
      attempts: 0,
      lastError: null,
    });
  });
});

describe("the notice", () => {
  it("posts exactly one new message and never touches the poll post", async () => {
    await db(env).insert(schema.pollResponses).values({ pollDateId: dates[0]!, userId: "opener" });
    await armPollClose(env, POLL, NOW - 1);

    await drainJobs(env);

    expect(calls).toMatchObject([{ path: "/channels/chan-1/messages" }]);
    expect(calls[0]?.body).toMatchObject({ content: expect.stringContaining("Answers are in.") });
    expect((await closeJob())?.state).toBe("done");
  });

  it("posts nothing further on a redelivery", async () => {
    await armPollClose(env, POLL, NOW - 1);
    await drainJobs(env);
    calls = [];

    await db(env)
      .update(schema.jobs)
      .set({ state: "pending", attempts: 0 })
      .where(eq(schema.jobs.id, `poll.close:${POLL}`));
    await drainJobs(env);

    // A second "answers are in" is worse than one arriving late, and under
    // send-only the first cannot be taken back.
    expect(calls).toEqual([]);
  });

  it("says so plainly when nobody could make any of them", async () => {
    await armPollClose(env, POLL, NOW - 1);

    await drainJobs(env);

    expect(String(calls[0]?.body.content)).toContain("Nobody could make any of these");
  });

  it("says nothing about a poll somebody already canonised", async () => {
    await db(env)
      .update(schema.datePolls)
      .set({ status: "closed" })
      .where(eq(schema.datePolls.id, POLL));
    await armPollClose(env, POLL, NOW - 1);

    await drainJobs(env);

    expect(calls).toEqual([]);
    expect((await closeJob())?.state).toBe("done");
  });

  it("acks a job for a poll that is gone", async () => {
    await armPollClose(env, POLL, NOW - 1);
    await env.DB.prepare("DELETE FROM date_polls").run();

    await drainJobs(env);

    expect(calls).toEqual([]);
    expect((await closeJob())?.state).toBe("done");
  });
});

describe("the post that stops answering", () => {
  it("refuses a selection after the deadline, and writes nothing", async () => {
    await armPollClose(env, POLL, NOW - 1);

    const res = await app.fetch(await click("select", [dates[0]!]), discord.env(env));
    const json = (await res.json()) as { type: number; data: { content: string } };

    // Orrey cannot disarm the select, so the handler is the gate. The post is
    // left exactly as it is — the refusal is ephemeral.
    expect(json.type).toBe(InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE);
    expect(json.data.content).toContain("closed");
    expect(await answers()).toEqual([]);
  });

  it("refuses a selection on a poll that was canonised", async () => {
    await db(env)
      .update(schema.datePolls)
      .set({ status: "closed" })
      .where(eq(schema.datePolls.id, POLL));

    await app.fetch(await click("select", [dates[0]!]), discord.env(env));

    expect(await answers()).toEqual([]);
  });

  it("still takes answers right up to the deadline", async () => {
    await armPollClose(env, POLL, NOW + 3600);

    await app.fetch(await click("select", [dates[0]!]), discord.env(env));

    expect(await answers()).toHaveLength(1);
  });

  it("lets the organiser canonise after the deadline", async () => {
    await armPollClose(env, POLL, NOW - 1);

    const res = await app.fetch(await click("canon", undefined, "opener"), discord.env(env));

    // Closing the answers is not closing the poll. A deadline that also locked
    // the organiser out would leave a dead post nobody could settle.
    expect(((await res.json()) as { type: number }).type).toBe(
      InteractionResponseType.UPDATE_MESSAGE,
    );
  });
});

describe("a pick on a closed poll", () => {
  it("re-renders the closed post rather than reopening it", async () => {
    await db(env).update(schema.datePolls).set({ status: "closed" });

    const res = await app.fetch(
      await click("pick", [dates[0]!], "opener"),
      discord.env(env),
    );
    const answer = (await res.json()) as { type: number; data: { content: string } };

    // `stagePicks` already writes nothing to a closed poll. What was missing was
    // the *answer*: this is an UPDATE_MESSAGE, so a post reading "Closed" would
    // be rewritten into a live override view with a working Apply button — on a
    // poll whose outcomes are final and whose consequences have already fired.
    expect(answer.data.content).not.toContain("Change them if it got it wrong");
    expect(answer.data.content).not.toContain("Closing the poll");
  });
});
