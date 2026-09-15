import { env } from "cloudflare:test";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db, schema } from "../src/db/index.ts";
import type { Env, OutboxMessage } from "../src/env.ts";
import { SETTING_KEYS, setSetting } from "../src/db/settings.ts";
import { ASSUME_JOB } from "../src/attendance/assume.ts";
import { drainJobs } from "../src/jobs/drain.ts";
import { claimSeat } from "../src/game-days/signups.ts";
import {
  CANCELLED_JOB,
  playAfterAssume,
  sessionIdFor,
  transition,
} from "../src/game-days/lifecycle.ts";

/**
 * How a day ends: played, or called off.
 *
 * Both ride machinery that already exists — `attendance.assume` at `ends_at`,
 * and `enqueueUnprojection`. No new job and no new clock for the first; no edit
 * of anything for the second.
 */
const realFetch = globalThis.fetch;
const START = Date.parse("2026-11-07T18:00:00Z") / 1000;
const DAY_ID = "day-1";
const SESSION_ID = sessionIdFor(DAY_ID);

let calls: { path: string; body: Record<string, unknown> }[] = [];
let sent: OutboxMessage[] = [];

function outboxEnv(): Env {
  return {
    ...env,
    OUTBOX: {
      send: async (body: OutboxMessage) => void sent.push(body),
      sendBatch: async (batch: Iterable<{ body: OutboxMessage }>) => {
        for (const { body } of batch) sent.push(body);
      },
    } as unknown as Env["OUTBOX"],
  } as Env;
}

async function day(over: Partial<typeof schema.gameDays.$inferInsert> = {}) {
  await db(env)
    .insert(schema.gameDays)
    .values({
      id: DAY_ID,
      kind: "single",
      gameId: "blades",
      state: "LOCKED",
      startsAt: START,
      endsAt: START + 18_000,
      venue: "The Wreck",
      discordChannelId: "chan-1",
      discordMessageId: "day-msg",
      threadId: "day-thread",
      ...over,
    });
}

async function session(over: Partial<typeof schema.sessions.$inferInsert> = {}) {
  await db(env)
    .insert(schema.sessions)
    .values({
      id: SESSION_ID,
      kind: "one_off",
      gameDayId: DAY_ID,
      startsAt: START,
      endsAt: START + 18_000,
      ...over,
    });
}

function dayRow() {
  return db(env).select().from(schema.gameDays).where(eq(schema.gameDays.id, DAY_ID)).get();
}

function sessionRow(id = SESSION_ID) {
  return db(env).select().from(schema.sessions).where(eq(schema.sessions.id, id)).get();
}

async function armAssumeNow() {
  await db(env)
    .insert(schema.jobs)
    .values({
      id: `${ASSUME_JOB}:${SESSION_ID}`,
      kind: ASSUME_JOB,
      payload: { sessionId: SESSION_ID },
      idempotencyKey: `${ASSUME_JOB}:${SESSION_ID}`,
      runAt: sql`(unixepoch())`,
    })
    .onConflictDoUpdate({
      target: schema.jobs.id,
      set: { runAt: sql`(unixepoch())`, state: "pending", attempts: 0 },
    });
}

beforeEach(async () => {
  calls = [];
  sent = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    calls.push({
      path: url.pathname.replace("/api/v10", ""),
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
    });
    return Response.json({ id: `msg-${calls.length}`, channel_id: "day-thread" });
  }) as typeof fetch;

  for (const table of [
    "audit_log",
    "publications",
    "attendance",
    "signups",
    "jobs",
    "sessions",
    "game_days",
    "campaigns",
    "games",
    "users",
    "settings",
  ]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  await setSetting(env, SETTING_KEYS.guildId, "g1");
  await db(env)
    .insert(schema.games)
    .values({ id: "blades", name: "Blades in the Dark", minPlayers: 3, maxPlayers: 4 });
  await db(env)
    .insert(schema.users)
    .values({ discordId: "organiser", username: "org", feedToken: "t-org" });
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("a day that was played", () => {
  it("is moved by the assume job at the end of its evening", async () => {
    await day();
    await session();
    await armAssumeNow();

    await drainJobs(env);

    expect(await dayRow()).toMatchObject({ state: "PLAYED" });
    expect(await sessionRow()).toMatchObject({ state: "PLAYED" });
  });

  it("is moved even when nobody claimed a seat", async () => {
    await day();
    await session();
    await armAssumeNow();

    await drainJobs(env);

    // A day nobody came to is still a day that has been and gone.
    expect(await dayRow()).toMatchObject({ state: "PLAYED" });
  });

  it("locks a day nobody locked, on the way past", async () => {
    await day({ state: "SEATING" });
    await session();

    expect(await playAfterAssume(env, DAY_ID)).toBe(true);

    // The lock job failed or was never armed. The evening is over, so the table
    // has certainly settled — leaving the day SEATING would strand it in a state
    // the map gives it no way out of.
    expect(await dayRow()).toMatchObject({ state: "PLAYED" });
  });

  it("does not play one that was called off", async () => {
    await day({ state: "CANCELLED" });
    await session({ state: "CANCELLED" });

    expect(await playAfterAssume(env, DAY_ID)).toBe(false);
    expect(await dayRow()).toMatchObject({ state: "CANCELLED" });
  });

  it("is a no-op the second time", async () => {
    await day();
    await session();
    await playAfterAssume(env, DAY_ID);

    expect(await playAfterAssume(env, DAY_ID)).toBe(false);
  });

  it("leaves a campaign session's assume exactly as it was", async () => {
    await db(env)
      .insert(schema.campaigns)
      .values({ id: "c1", name: "Age of Umbra", kind: "run", state: "RUNNING" });
    await db(env)
      .insert(schema.sessions)
      .values({
        id: "c1-s1",
        kind: "campaign_session",
        campaignId: "c1",
        number: 1,
        startsAt: START,
        endsAt: START + 3600,
      });
    await db(env)
      .insert(schema.jobs)
      .values({
        id: `${ASSUME_JOB}:c1-s1`,
        kind: ASSUME_JOB,
        payload: { sessionId: "c1-s1" },
        idempotencyKey: `${ASSUME_JOB}:c1-s1`,
        runAt: sql`(unixepoch())`,
      });

    await drainJobs(env);

    expect(await sessionRow("c1-s1")).toMatchObject({ state: "PLAYED" });
  });
});

describe("a day that was called off", () => {
  it("takes both calendar entries down, when the notice job runs", async () => {
    await day({ state: "SEATING" });
    await session();

    await transition(outboxEnv(), DAY_ID, "CANCELLED", "organiser");
    // Nothing yet: the transition owes the deletes, it does not send them. The
    // job row written in its batch is what owes them.
    expect(sent).toEqual([]);

    await drainJobs(outboxEnv());

    expect(sent).toEqual([
      { kind: "discord.event.delete", sessionId: SESSION_ID },
      { kind: "gcal.delete", sessionId: SESSION_ID },
    ]);
  });

  it("still owes them after a queue that was down", async () => {
    await day({ state: "SEATING" });
    await session();
    await transition(outboxEnv(), DAY_ID, "CANCELLED", "organiser");

    let refuse = true;
    const flaky = {
      ...env,
      OUTBOX: {
        send: async () => {
          throw new Error("queue is having a day");
        },
        sendBatch: async (batch: Iterable<{ body: OutboxMessage }>) => {
          if (refuse) throw new Error("queue is having a day");
          for (const { body } of batch) sent.push(body);
        },
      } as unknown as Env["OUTBOX"],
    } as Env;

    await drainJobs(flaky);
    expect(sent).toEqual([]);

    // Cancelling is terminal — `EDGES.CANCELLED` is empty and `from === to`
    // returns early — so a retraction sent from the transition would have been
    // lost here for good, on a day whose notice says the entries came down.
    // Owed by the job, it is simply owed again.
    refuse = false;
    await db(env)
      .update(schema.jobs)
      .set({ runAt: Math.floor(Date.now() / 1000) - 60 })
      .where(eq(schema.jobs.id, `${CANCELLED_JOB}:${DAY_ID}`));
    await drainJobs(flaky);

    expect(sent).toEqual([
      { kind: "discord.event.delete", sessionId: SESSION_ID },
      { kind: "gcal.delete", sessionId: SESSION_ID },
    ]);
  });

  it("escapes a title and a venue somebody typed markdown into", async () => {
    await day({ state: "SEATING", kind: "multi", gameId: null, title: "November `games` day" });
    await session();
    await transition(outboxEnv(), DAY_ID, "CANCELLED", "organiser");

    await drainJobs(outboxEnv());

    // A stray backtick opens a code span that never closes, swallowing the
    // timestamp and the line about the calendar — on a message never edited.
    const notice = calls.at(-1)?.body as { content: string };
    expect(notice.content).toContain("November \\`games\\` day");
  });

  it("calls the session off with it", async () => {
    await day({ state: "SEATING" });
    await session();

    await transition(outboxEnv(), DAY_ID, "CANCELLED", "organiser");

    // Leaving it SCHEDULED would let a late assume write a register for a day
    // nobody played.
    expect(await sessionRow()).toMatchObject({ state: "CANCELLED" });
  });

  it("posts exactly one notice, in the day's thread", async () => {
    await day({ state: "SEATING" });
    await session();
    await transition(outboxEnv(), DAY_ID, "CANCELLED", "organiser");
    calls = [];

    await drainJobs(env);

    expect(calls).toMatchObject([{ path: "/channels/day-thread/messages" }]);
    expect(calls[0]?.body).toMatchObject({
      content: expect.stringContaining("It's off."),
      allowed_mentions: { parse: [], roles: [] },
    });
  });

  it("never touches the signup post", async () => {
    await day({ state: "SEATING" });
    await session();
    await transition(outboxEnv(), DAY_ID, "CANCELLED", "organiser");
    calls = [];

    await drainJobs(env);

    // The one place in this phase where reaching for a message edit would feel
    // natural. The notice is the answer.
    expect(calls.every((call) => call.path === "/channels/day-thread/messages")).toBe(true);
    expect(await dayRow()).toMatchObject({ discordMessageId: "day-msg" });
  });

  it("posts once and enqueues one pair, however often it is asked", async () => {
    await day({ state: "SEATING" });
    await session();
    await transition(outboxEnv(), DAY_ID, "CANCELLED", "organiser");
    await drainJobs(env);
    calls = [];
    sent = [];

    // Already CANCELLED: `transition` says so and writes nothing.
    expect(await transition(outboxEnv(), DAY_ID, "CANCELLED", "organiser")).toMatchObject({
      changed: false,
    });
    await db(env).update(schema.jobs).set({ state: "pending", attempts: 0 });
    await drainJobs(env);

    expect(sent).toEqual([]);
    // And the claim under the `cancelled` label is what makes a re-run silent.
    expect(calls).toEqual([]);
  });

  it("says nothing and enqueues nothing for a day with no session yet", async () => {
    await day({ state: "PROPOSED" });

    await transition(outboxEnv(), DAY_ID, "CANCELLED", "organiser");

    // Nothing was ever published about a PROPOSED day, and there is no thread to
    // post into.
    expect(sent).toEqual([]);
    expect(await db(env).select().from(schema.jobs).all()).toEqual([]);
  });

  it("leaves the seats exactly where they were", async () => {
    await day({ state: "SEATING" });
    await session();
    await db(env)
      .insert(schema.users)
      .values({ discordId: "p0", username: "p0", feedToken: "t0" });
    await claimSeat(env, DAY_ID, "p0");

    await transition(outboxEnv(), DAY_ID, "CANCELLED", "organiser");

    // History, not housekeeping: who had a seat at the day that was called off
    // is a thing that stays true.
    expect(await db(env).select().from(schema.signups).all()).toMatchObject([{ state: "in" }]);
  });

  it("writes the record of who called it off", async () => {
    await day({ state: "SEATING" });
    await session();

    await transition(outboxEnv(), DAY_ID, "CANCELLED", "organiser");

    expect(await db(env).select().from(schema.auditLog).all()).toMatchObject([
      { actorUserId: "organiser", detail: { before: "SEATING", after: "CANCELLED" } },
    ]);
  });
});

describe("the cancellation job", () => {
  it("is named once and armed once", async () => {
    await day({ state: "SEATING" });
    await session();

    await transition(outboxEnv(), DAY_ID, "CANCELLED", "organiser");

    expect(
      await db(env).select().from(schema.jobs).where(eq(schema.jobs.kind, CANCELLED_JOB)).all(),
    ).toHaveLength(1);
  });

  it("says nothing about a day that has since been deleted", async () => {
    await day({ state: "SEATING" });
    await session();
    await transition(outboxEnv(), DAY_ID, "CANCELLED", "organiser");
    await env.DB.prepare("DELETE FROM game_days").run();
    calls = [];

    await drainJobs(env);

    expect(calls).toEqual([]);
  });
});
