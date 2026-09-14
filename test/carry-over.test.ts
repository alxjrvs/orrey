import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db, schema } from "../src/db/index.ts";
import { SETTING_KEYS, setSetting } from "../src/db/settings.ts";
import { mintId } from "../src/db/ids.ts";
import { createApp } from "../src/http/app.ts";
import { InteractionType } from "../src/discord/types.ts";
import { encodeCustomId } from "../src/discord/custom-id.ts";
import { fakeDiscord } from "./discord.ts";
import { drainJobs } from "../src/jobs/drain.ts";
import { find } from "../src/projection/publications.ts";

/**
 * The available players, onto the new date. The half that matters most is what
 * is *not* carried: an answer about the old date is not an answer about the new
 * one.
 */
const realFetch = globalThis.fetch;
const discord = await fakeDiscord();
const app = createApp();
const SESSION = "umbra-s12";
const POLL = "pollid123456";
const NOW = Math.floor(Date.now() / 1000);
const DAY = 86_400;

let calls: { method: string; path: string }[] = [];
let dates: string[] = [];

async function person(id: string) {
  await db(env)
    .insert(schema.users)
    .values({ discordId: id, username: id, feedToken: `t-${id}` })
    .onConflictDoNothing();
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
  await person("opener");
  await db(env).insert(schema.sessions).values({
    id: SESSION,
    kind: "campaign_session",
    campaignId: "umbra",
    number: 12,
    startsAt: NOW + 7 * DAY,
    endsAt: NOW + 7 * DAY + 4 * 3600,
    location: "The Wreck",
    threadId: "thread-1",
    discordMessageId: "msg-old",
  });
  await db(env)
    .insert(schema.datePolls)
    .values({
      id: POLL,
      targetSessionId: SESSION,
      campaignId: "umbra",
      discordChannelId: "chan-1",
      openedBy: "opener",
      winRule: "organiser_picks",
    });

  dates = [];
  for (const offset of [30, 37]) {
    const id = mintId();
    const at = NOW + offset * DAY;
    await db(env)
      .insert(schema.pollDates)
      .values({ id, pollId: POLL, startsAt: at, endsAt: at + 4 * 3600 });
    dates.push(id);
  }
}

async function availableOn(pollDateId: string, ...userIds: string[]) {
  for (const userId of userIds) {
    await person(userId);
    await db(env).insert(schema.pollResponses).values({ pollDateId, userId });
  }
}

async function saidOnOldDate(userId: string, intent: "in" | "out" | "maybe", note?: string) {
  await person(userId);
  await db(env)
    .insert(schema.attendance)
    .values({ sessionId: SESSION, userId, intent, note: note ?? null });
}

function click(arg: string, values?: string[]) {
  return discord.request({
    type: InteractionType.MESSAGE_COMPONENT,
    data: {
      custom_id: encodeCustomId({ action: "poll", arg, target: POLL }),
      component_type: values ? 3 : 2,
      ...(values ? { values } : {}),
    },
    member: { user: { id: "opener", username: "opener", global_name: null }, roles: [] },
    guild_id: "g",
    message: { id: "msg-1", channel_id: "chan-1" },
  });
}

/**
 * Canonise, pick, Apply — then the drain. Apply arms `poll.apply` in the same
 * batch as the close rather than doing the move itself, so that a poll cannot
 * end up closed with a move nothing can retry.
 */
async function canoniseWith(pollDateId: string) {
  await app.fetch(await click("canon"), discord.env(env));
  await app.fetch(await click("pick", [pollDateId]), discord.env(env));
  await app.fetch(await click("apply"), discord.env(env));
  await drainJobs(env);
}

function register() {
  return db(env).select().from(schema.attendance).all();
}

function intentOf(rows: (typeof schema.attendance.$inferSelect)[], userId: string) {
  return rows.find((row) => row.userId === userId)?.intent;
}

beforeEach(async () => {
  calls = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    calls.push({ method: init?.method ?? "GET", path: url.pathname.replace("/api/v10", "") });
    return Response.json({ id: `msg-${calls.length}`, channel_id: "chan-1" });
  }) as typeof fetch;

  for (const table of [
    "publications",
    "poll_responses",
    "poll_dates",
    "date_polls",
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
});

describe("who comes across", () => {
  it("writes in for everyone available on the winning date", async () => {
    await availableOn(dates[0]!, "ada", "bo", "cy");
    await availableOn(dates[1]!, "di");

    await canoniseWith(dates[0]!);

    const rows = await register();
    expect(intentOf(rows, "ada")).toBe("in");
    expect(intentOf(rows, "bo")).toBe("in");
    expect(intentOf(rows, "cy")).toBe("in");
    // Available on a losing date is not available on the winning one.
    expect(rows.find((row) => row.userId === "di")).toBeUndefined();
  });

  it("clears an answer about the old date rather than carrying it", async () => {
    await saidOnOldDate("ada", "out");
    await saidOnOldDate("bo", "in");
    await availableOn(dates[0]!, "ada");

    await canoniseWith(dates[0]!);

    const rows = await register();
    // Ada said out about a Tuesday and available about a Thursday. The Thursday
    // answer is the one that is about this date now.
    expect(intentOf(rows, "ada")).toBe("in");
    // Bo said in about the old date and nothing about the poll. Carrying that
    // over would be Orrey putting words in their mouth.
    expect(intentOf(rows, "bo")).toBeNull();
  });

  it("keeps notes, which are about the session and not about the date", async () => {
    await saidOnOldDate("bo", "in", "No car this month");

    await canoniseWith(dates[0]!);

    expect((await register()).find((row) => row.userId === "bo")?.note).toBe("No car this month");
  });

  it("writes intent and never attended", async () => {
    await availableOn(dates[0]!, "ada");

    await canoniseWith(dates[0]!);

    // A session that has not happened has nobody who came. `attended` is the
    // register's and nothing here may set it.
    expect((await register()).find((row) => row.userId === "ada")).toMatchObject({
      intent: "in",
      attended: null,
      attendedSource: null,
    });
  });
});

describe("the fresh post", () => {
  it("forgets the old id and posts a new one", async () => {
    await availableOn(dates[0]!, "ada");

    await canoniseWith(dates[0]!);

    expect(
      await db(env).select().from(schema.sessions).where(eq(schema.sessions.id, SESSION)).get(),
    ).toMatchObject({ discordMessageId: null });

    // A deliberate forget, not a reconcile: Orrey is not tracking two posts, it
    // is tracking the newest one.
    expect(
      await find(env, { surface: "discord", kind: "message", targetId: SESSION }),
    ).toBeUndefined();

    calls = [];
    await drainJobs(env);
    const posts = calls.filter((call) => call.path === "/channels/chan-1/messages");
    expect(posts.length).toBeGreaterThan(0);
    expect(
      await db(env).select().from(schema.sessions).where(eq(schema.sessions.id, SESSION)).get(),
    ).not.toMatchObject({ discordMessageId: "msg-old" });
  });

  it("does not post twice when Apply runs again", async () => {
    await availableOn(dates[0]!, "ada");
    await canoniseWith(dates[0]!);
    await drainJobs(env);
    calls = [];

    // A second Apply on a closed poll is already refused, and a re-apply that
    // settles on the date the session is already on must not wipe the answers.
    await app.fetch(await click("apply"), discord.env(env));
    await drainJobs(env);

    expect(calls.filter((call) => call.path === "/channels/chan-1/messages")).toEqual([]);
    expect((await register()).find((row) => row.userId === "ada")?.intent).toBe("in");
  });
});

describe("what a refused notice costs", () => {
  it("does not lose the carry-over when the Moved notice fails", async () => {
    await availableOn(dates[0]!, "ada");

    let failed = false;
    const inner = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      );
      if (!failed && url.pathname.includes("/messages")) {
        failed = true;
        return Response.json({ message: "boom" }, { status: 500 });
      }
      return inner(input as RequestInfo, init);
    }) as typeof fetch;

    await app.fetch(await click("canon"), discord.env(env));
    await app.fetch(await click("pick", [dates[0]!]), discord.env(env));
    await app.fetch(await click("apply"), discord.env(env));
    await drainJobs(env);

    // Before this, Apply closed the poll and *then* moved — and its own guard
    // refuses a closed poll, so a refusal here lost the move, the re-projection
    // and every answer's carry-over for good. Now the drain owns it.
    await db(env).update(schema.jobs).set({ state: "pending", attempts: 0 });
    await drainJobs(env);

    expect((await register()).find((row) => row.userId === "ada")?.intent).toBe("in");
  });
});
