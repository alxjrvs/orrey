import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db, schema } from "../src/db/index.ts";
import { SETTING_KEYS, setSetting } from "../src/db/settings.ts";
import { drainJobs } from "../src/jobs/drain.ts";
import { encodeCustomId } from "../src/discord/custom-id.ts";
import { InteractionResponseType, InteractionType, MessageFlags } from "../src/discord/types.ts";
import { createApp } from "../src/http/app.ts";
import { LOCK_JOB, armLock, lockIfSeating, transition } from "../src/game-days/lifecycle.ts";
import { claimSeat, signupsForDay } from "../src/game-days/signups.ts";
import { fakeDiscord } from "./discord.ts";

/**
 * The lead-time lock, armed and handled together.
 *
 * The job is a fallback for the day nobody locked by hand, so what is worth
 * testing is that it is harmless on every day that is not seating — and that a
 * click arriving after it answers ephemerally rather than rewriting a post that
 * has not changed.
 */
const discord = await fakeDiscord();
const app = createApp();
const START = Date.parse("2026-11-07T18:00:00Z") / 1000;
const DAY_ID = "day-1";

async function day(over: Partial<typeof schema.gameDays.$inferInsert> = {}) {
  await db(env)
    .insert(schema.gameDays)
    .values({
      id: DAY_ID,
      kind: "single",
      gameId: "blades",
      state: "SEATING",
      startsAt: START,
      endsAt: START + 18_000,
      discordChannelId: "chan-1",
      discordMessageId: "msg-1",
      ...over,
    });
}

function dayRow() {
  return db(env).select().from(schema.gameDays).where(eq(schema.gameDays.id, DAY_ID)).get();
}

function lockJob() {
  return db(env)
    .select()
    .from(schema.jobs)
    .where(eq(schema.jobs.id, `${LOCK_JOB}:${DAY_ID}`))
    .get();
}

/**
 * Bring the armed lock forward to now — which is what the clock does. Arming at
 * a time already past is the thing the clamp exists to prevent, so a test that
 * wants a due lock has to age one rather than arm one.
 */
async function mature() {
  await db(env)
    .update(schema.jobs)
    .set({ runAt: Math.floor(Date.now() / 1000) - 60 })
    .where(eq(schema.jobs.id, `${LOCK_JOB}:${DAY_ID}`));
}

function audit() {
  return db(env).select().from(schema.auditLog).all();
}

async function click(arg: string, who: string) {
  const res = await app.fetch(
    await discord.request({
      type: InteractionType.MESSAGE_COMPONENT,
      data: { custom_id: encodeCustomId({ action: "seat", arg, target: DAY_ID }), component_type: 2 },
      member: { user: { id: who, username: who, global_name: `Player ${who}` }, roles: [] },
      message: { id: "msg-1", channel_id: "chan-1" },
    }),
    discord.env(env),
  );
  return (await res.json()) as { type: number; data: { content: string; flags?: number } };
}

beforeEach(async () => {
  for (const table of [
    "audit_log",
    "publications",
    "signups",
    "jobs",
    "sessions",
    "game_days",
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

afterEach(async () => {
  await env.DB.prepare("DELETE FROM settings").run();
});

describe("arming it", () => {
  it("puts it the lead time before the day, by default", async () => {
    await day({ state: "PROPOSED" });
    await transition(env, DAY_ID, "SEATING", "organiser");

    expect(await lockJob()).toMatchObject({
      kind: LOCK_JOB,
      state: "pending",
      runAt: START - 48 * 3600,
    });
  });

  it("takes the lead time from settings", async () => {
    await setSetting(env, SETTING_KEYS.gameDayLockLeadHours, 6);
    await day({ state: "PROPOSED" });
    await transition(env, DAY_ID, "SEATING", "organiser");

    expect((await lockJob())?.runAt).toBe(START - 6 * 3600);
  });

  it("moves with the day rather than making a second one", async () => {
    await day();
    await armLock(env, DAY_ID, START);
    const moved = START + 7 * 86_400;

    await armLock(env, DAY_ID, moved);

    // A lock still pointing at the old date would settle the table two days
    // before the wrong evening.
    expect((await lockJob())?.runAt).toBe(moved - 48 * 3600);
    expect(
      await db(env).select().from(schema.jobs).where(eq(schema.jobs.kind, LOCK_JOB)).all(),
    ).toHaveLength(1);
  });

  it("un-fails one that failed before the day moved", async () => {
    await day();
    await armLock(env, DAY_ID, START);
    await db(env)
      .update(schema.jobs)
      .set({ state: "failed", attempts: 3, lastError: "something" })
      .where(eq(schema.jobs.id, `${LOCK_JOB}:${DAY_ID}`));

    await armLock(env, DAY_ID, START + 86_400);

    expect(await lockJob()).toMatchObject({ state: "pending", attempts: 0, lastError: null });
  });
});

describe("what the job does", () => {
  it("locks a day that is still seating", async () => {
    await day();

    expect(await lockIfSeating(env, DAY_ID)).toBe(true);
    expect(await dayRow()).toMatchObject({ state: "LOCKED" });
    // The clock acts on nobody's behalf, and the log says so rather than naming
    // whoever happened to open seating.
    expect(await audit()).toMatchObject([{ actorUserId: null, detail: { after: "LOCKED" } }]);
  });

  it("is harmless on a day the organiser already locked", async () => {
    await day({ state: "LOCKED" });

    expect(await lockIfSeating(env, DAY_ID)).toBe(false);
    expect(await audit()).toEqual([]);
  });

  it("is harmless on one that was called off, or played", async () => {
    for (const state of ["CANCELLED", "PLAYED", "PROPOSED"] as const) {
      await env.DB.prepare("DELETE FROM game_days").run();
      await day({ state });

      expect(await lockIfSeating(env, DAY_ID)).toBe(false);
      expect(await dayRow()).toMatchObject({ state });
    }
  });

  it("is harmless on a day that is gone", async () => {
    expect(await lockIfSeating(env, "nowhere")).toBe(false);
  });

  it("runs when its time comes, and acks", async () => {
    await day();
    await armLock(env, DAY_ID, Math.floor(Date.now() / 1000) + 10 * 86_400);
    await mature();

    await drainJobs(env);

    expect(await dayRow()).toMatchObject({ state: "LOCKED" });
    expect((await lockJob())?.state).toBe("done");
  });

  it("acks rather than failing on an ordinary already-locked day", async () => {
    await day({ state: "LOCKED" });
    await armLock(env, DAY_ID, Math.floor(Date.now() / 1000) + 10 * 86_400);
    await mature();

    await drainJobs(env);

    // A job that fails on the ordinary case is a job that fills `last_error`
    // with nothing wrong.
    expect(await lockJob()).toMatchObject({ state: "done", lastError: null });
  });

  it("is not already due for a day opened inside the lead time", async () => {
    await day();
    const startsAt = Math.floor(Date.now() / 1000) + 86_400;

    // A day tomorrow, against a two-day default. Arming at starts_at - 48h
    // would be a lock due before the signup post it was armed beside.
    await armLock(env, DAY_ID, startsAt);
    await drainJobs(env);

    expect(await dayRow()).toMatchObject({ state: "SEATING" });
    expect((await lockJob())?.runAt).toBe(startsAt);
  });

  it("still arms at the lead time for a day far enough out", async () => {
    await day();
    const startsAt = Math.floor(Date.now() / 1000) + 10 * 86_400;

    await armLock(env, DAY_ID, startsAt);

    expect((await lockJob())?.runAt).toBe(startsAt - 48 * 3600);
  });

  it("posts nothing at all", async () => {
    const realFetch = globalThis.fetch;
    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calls.push(String(typeof input === "string" ? input : (input as Request).url));
      return Response.json({ id: "msg-x" });
    }) as typeof fetch;

    try {
      await day();
      await armLock(env, DAY_ID, Math.floor(Date.now() / 1000) + 48 * 3600 - 60);
      await drainJobs(env);

      // The signup post's buttons outlive the lock, because a post is never
      // edited. The handler is what tells a late clicker what happened.
      expect(calls).toEqual([]);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe("a click that arrives too late", () => {
  it("writes nothing and says so ephemerally", async () => {
    await day();
    await db(env)
      .insert(schema.users)
      .values({ discordId: "1", username: "p1", feedToken: "t1" });
    await claimSeat(env, DAY_ID, "1");
    await lockIfSeating(env, DAY_ID);

    const answer = await click("in", "2");

    expect(answer.type).toBe(InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE);
    expect(answer.data.flags! & MessageFlags.EPHEMERAL).toBeTruthy();
    expect(answer.data.content).toContain("settled");
    expect(await signupsForDay(env, DAY_ID)).toHaveLength(1);
  });

  it("does not rewrite the post", async () => {
    await day();
    await lockIfSeating(env, DAY_ID);

    const answer = await click("out", "1");

    // Nothing changed, and rewriting the post would make a stale reading look
    // fresh. Refresh is how a snapshot becomes current.
    expect(answer.type).not.toBe(InteractionResponseType.UPDATE_MESSAGE);
  });

  it("still lets somebody look", async () => {
    await day();
    await lockIfSeating(env, DAY_ID);

    expect((await click("refresh", "1")).type).toBe(InteractionResponseType.UPDATE_MESSAGE);
  });
});

describe("locking by hand", () => {
  it("is refused on a played day by the map, not by the console", async () => {
    await day({ state: "PLAYED" });

    await expect(transition(env, DAY_ID, "LOCKED", "organiser")).rejects.toThrow(
      "PLAYED → LOCKED",
    );
  });
});
