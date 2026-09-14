import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db, schema } from "../src/db/index.ts";
import { SETTING_KEYS, setSetting } from "../src/db/settings.ts";
import { drainJobs } from "../src/jobs/drain.ts";
import { claimSeat, signupsForDay, withdraw } from "../src/game-days/signups.ts";
import { PROMOTED_JOB, nextUp, promoteFromWaitlist } from "../src/game-days/promote.ts";
import { promotedNotice } from "../src/game-days/notice.ts";

/**
 * A freed seat, and a new post saying so.
 *
 * The thing that must not happen is the signup post being rewritten from the
 * outside. The person who clicked Out already had it rewritten as their own
 * interaction's response; the promoted player is told by a post addressed to
 * them; everybody else finds out on Refresh.
 */
const realFetch = globalThis.fetch;
const START = Date.parse("2026-11-07T18:00:00Z") / 1000;
const DAY_ID = "day-1";

let calls: { method: string; path: string; body: Record<string, unknown> }[] = [];

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
      venue: "The Wreck",
      discordChannelId: "chan-1",
      discordMessageId: "msg-1",
      threadId: "thread-1",
      ...over,
    });
}

async function people(count: number) {
  const ids = Array.from({ length: count }, (_, i) => `p${i}`);
  for (const id of ids) {
    await db(env)
      .insert(schema.users)
      .values({ discordId: id, username: id, globalName: `Player ${id}`, feedToken: `t-${id}` })
      .onConflictDoNothing();
  }
  return ids;
}

function states() {
  return signupsForDay(env, DAY_ID).then((rows) =>
    rows.map((row) => [row.userId, row.state, row.position]),
  );
}

function jobs() {
  return db(env).select().from(schema.jobs).all();
}

function dayRow() {
  return db(env).select().from(schema.gameDays).where(eq(schema.gameDays.id, DAY_ID)).get();
}

beforeEach(async () => {
  calls = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    calls.push({
      method: init?.method ?? "GET",
      path: url.pathname.replace("/api/v10", ""),
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
    });
    return Response.json({ id: `msg-${calls.length}`, channel_id: "thread-1" });
  }) as typeof fetch;

  for (const table of ["publications", "signups", "jobs", "game_days", "games", "users", "settings"]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  await setSetting(env, SETTING_KEYS.guildId, "g1");
  await db(env)
    .insert(schema.games)
    .values({ id: "blades", name: "Blades in the Dark", maxPlayers: 2 });
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("who moves", () => {
  it("promotes the head of the queue, and only them", async () => {
    await day();
    const ids = await people(4);
    for (const id of ids) await claimSeat(env, DAY_ID, id);
    await withdraw(env, DAY_ID, ids[0]!);

    expect(await promoteFromWaitlist(env, DAY_ID)).toEqual([{ userId: "p2", position: 3 }]);
    expect(await states()).toEqual([
      ["p1", "in", 2],
      ["p2", "in", 3],
      ["p3", "waitlisted", 4],
    ]);
  });

  it("keeps the promoted row's position rather than renumbering", async () => {
    await day();
    const ids = await people(3);
    for (const id of ids) await claimSeat(env, DAY_ID, id);
    await withdraw(env, DAY_ID, ids[1]!);
    await promoteFromWaitlist(env, DAY_ID);

    // A state change, not a renumber — which is what makes replaying it a no-op
    // and stops two promotions racing into a gap.
    expect(await states()).toEqual([
      ["p0", "in", 1],
      ["p2", "in", 3],
    ]);
  });

  it("fills two seats when two came free", async () => {
    await day();
    const ids = await people(4);
    for (const id of ids) await claimSeat(env, DAY_ID, id);
    await withdraw(env, DAY_ID, ids[0]!);
    await withdraw(env, DAY_ID, ids[1]!);

    expect(await promoteFromWaitlist(env, DAY_ID)).toHaveLength(2);
  });

  it("promotes nobody when the table is still full", async () => {
    await day();
    const ids = await people(3);
    for (const id of ids) await claimSeat(env, DAY_ID, id);

    expect(await promoteFromWaitlist(env, DAY_ID)).toEqual([]);
    expect(await jobs()).toEqual([]);
  });

  it("promotes nobody when the waitlist is empty", async () => {
    await day();
    const ids = await people(1);
    await claimSeat(env, DAY_ID, ids[0]!);
    await withdraw(env, DAY_ID, ids[0]!);

    expect(await promoteFromWaitlist(env, DAY_ID)).toEqual([]);
    expect(await jobs()).toEqual([]);
  });

  it("has nothing to promote on a day with no capacity", async () => {
    await day({ kind: "multi", gameId: null });
    const ids = await people(5);
    for (const id of ids) await claimSeat(env, DAY_ID, id);

    // Everybody who claims a place on a day with no seat count is seated the
    // moment they claim it, so there is no queue to come off.
    expect(await promoteFromWaitlist(env, DAY_ID)).toEqual([]);
  });

  it("is a no-op the second time", async () => {
    await day();
    const ids = await people(3);
    for (const id of ids) await claimSeat(env, DAY_ID, id);
    await withdraw(env, DAY_ID, ids[0]!);
    await promoteFromWaitlist(env, DAY_ID);

    expect(await promoteFromWaitlist(env, DAY_ID)).toEqual([]);
    // One promotion, one notice armed — a retried job or a redelivery must not
    // produce a second person shuffled in or a second post.
    expect(await jobs()).toHaveLength(1);
  });

  it("says who is next without moving them", async () => {
    await day();
    const ids = await people(3);
    for (const id of ids) await claimSeat(env, DAY_ID, id);

    expect(await nextUp(env, DAY_ID)).toEqual({ userId: "p2", position: 3 });
    expect(await states()).toEqual([
      ["p0", "in", 1],
      ["p1", "in", 2],
      ["p2", "waitlisted", 3],
    ]);
  });
});

describe("going Out promotes, inside the lock", () => {
  function lock() {
    return env.SESSION_LOCK.get(env.SESSION_LOCK.idFromName(DAY_ID));
  }

  function actor(id: string) {
    return { id, username: id, global_name: `Player ${id}` };
  }

  it("lets the next person in as the seat comes free", async () => {
    await day();
    const ids = await people(3);
    for (const id of ids) await claimSeat(env, DAY_ID, id);

    const state = await lock().leaveSeat({ gameDayId: DAY_ID, actor: actor(ids[0]!) });

    // The click that frees the seat is the click that renders the new table.
    expect(state.signups.map((row) => [row.userId, row.state])).toEqual([
      ["p1", "in"],
      ["p2", "in"],
    ]);
  });

  it("promotes two different people when two go Out at once", async () => {
    await day();
    const ids = await people(4);
    for (const id of ids) await claimSeat(env, DAY_ID, id);

    await Promise.all([
      lock().leaveSeat({ gameDayId: DAY_ID, actor: actor(ids[0]!) }),
      lock().leaveSeat({ gameDayId: DAY_ID, actor: actor(ids[1]!) }),
    ]);

    // Outside the chain both would read "one seat free" and both promote the
    // head of the queue — one seat, two people, and the second one's row already
    // said `in`.
    expect(await states()).toEqual([
      ["p2", "in", 3],
      ["p3", "in", 4],
    ]);
  });

  it("promotes nobody when a waitlisted person goes Out", async () => {
    await day();
    const ids = await people(3);
    for (const id of ids) await claimSeat(env, DAY_ID, id);

    await lock().leaveSeat({ gameDayId: DAY_ID, actor: actor(ids[2]!) });

    expect(await states()).toEqual([
      ["p0", "in", 1],
      ["p1", "in", 2],
    ]);
    expect(await jobs()).toEqual([]);
  });

  it("does not promote when there was nothing to give back", async () => {
    await day();
    const ids = await people(3);
    for (const id of ids) await claimSeat(env, DAY_ID, id);

    await lock().leaveSeat({ gameDayId: DAY_ID, actor: { id: "stranger", username: "s" } });

    expect(await jobs()).toEqual([]);
  });
});

describe("the notice", () => {
  it("mentions exactly the people promoted and nobody else", () => {
    const payload = promotedNotice(
      { startsAt: START, venue: "The Wreck", kind: "single", title: null } as never,
      { name: "Blades in the Dark" } as never,
      ["p2"],
    );

    expect(payload.allowed_mentions).toEqual({ parse: [], roles: [], users: ["p2"] });
    expect(payload.content).toContain("<@p2>");
    expect(payload.content).toContain("Blades in the Dark");
    // No buttons: the signup post is where the clicking happens.
    expect(payload.components).toEqual([]);
  });

  it("goes into the day's thread, once", async () => {
    await day();
    const ids = await people(3);
    for (const id of ids) await claimSeat(env, DAY_ID, id);
    await withdraw(env, DAY_ID, ids[0]!);
    await promoteFromWaitlist(env, DAY_ID);
    calls = [];

    await drainJobs(env);

    expect(calls).toMatchObject([{ method: "POST", path: "/channels/thread-1/messages" }]);
    expect(calls[0]?.body).toMatchObject({
      content: expect.stringContaining("<@p2>"),
      allowed_mentions: { parse: [], roles: [], users: ["p2"] },
    });

    // And not twice, however often the job is re-run.
    calls = [];
    await db(env).update(schema.jobs).set({ state: "pending", attempts: 0 });
    await drainJobs(env);
    expect(calls).toEqual([]);
  });

  it("says nothing about a day that was called off in between", async () => {
    await day();
    const ids = await people(3);
    for (const id of ids) await claimSeat(env, DAY_ID, id);
    await withdraw(env, DAY_ID, ids[0]!);
    await promoteFromWaitlist(env, DAY_ID);
    await db(env).update(schema.gameDays).set({ state: "CANCELLED" });
    calls = [];

    await drainJobs(env);

    // "You're in" about a day nobody is running is worse than saying nothing.
    expect(calls).toEqual([]);
  });

  it("is a second notice when the same person is promoted twice", async () => {
    await day();
    const ids = await people(3);
    for (const id of ids) await claimSeat(env, DAY_ID, id);
    await withdraw(env, DAY_ID, ids[0]!);
    await promoteFromWaitlist(env, DAY_ID);
    await drainJobs(env);

    // p2 came in, went out, queued again behind nobody, and came in again.
    await withdraw(env, DAY_ID, ids[2]!);
    await claimSeat(env, DAY_ID, ids[2]!, { prefer: "waitlist" });
    await promoteFromWaitlist(env, DAY_ID);
    calls = [];
    await drainJobs(env);

    // A label made of who moved would let the first notice's claim swallow this
    // one. It is claimed per promotion instead.
    expect(calls).toHaveLength(1);
  });

  it("posts into the channel when the day has no thread", async () => {
    await day({ threadId: null });
    const ids = await people(3);
    for (const id of ids) await claimSeat(env, DAY_ID, id);
    await withdraw(env, DAY_ID, ids[0]!);
    await promoteFromWaitlist(env, DAY_ID);
    calls = [];

    await drainJobs(env);

    expect(calls[0]?.path).toBe("/channels/chan-1/messages");
    expect(await dayRow()).toMatchObject({ threadId: null });
  });
});
