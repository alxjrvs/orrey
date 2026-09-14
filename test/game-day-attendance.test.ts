import { env } from "cloudflare:test";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db, schema } from "../src/db/index.ts";
import { SETTING_KEYS, setSetting } from "../src/db/settings.ts";
import { drainJobs } from "../src/jobs/drain.ts";
import { loadProjectionTarget } from "../src/projection/target.ts";
import { attendanceRows } from "../src/attendance/rows.ts";
import { quorumOf, requiredFor } from "../src/attendance/quorum.ts";
import { checkJeopardy } from "../src/attendance/jeopardy.ts";
import { postAttendancePost } from "../src/attendance/post.ts";
import { startSessionThread } from "../src/attendance/thread.ts";
import { claimSeat, withdraw } from "../src/game-days/signups.ts";
import { promoteFromWaitlist } from "../src/game-days/promote.ts";

/**
 * The seated are the roster.
 *
 * There is no game-day attendance post. It is `renderAttendancePost`, the five
 * buttons phase 1 minted, and phase 3's ladder and jeopardy check, all reading a
 * different answer to one question: who is this for. If this slice added a
 * second renderer or a second post helper, the whole argument for giving a game
 * day a session row would have failed.
 */
const realFetch = globalThis.fetch;
const START = Date.parse("2026-11-07T18:00:00Z") / 1000;
const DAY_ID = "day-1";
const SESSION_ID = "day-1-session";

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
      discordMessageId: "day-msg",
      threadId: "day-thread",
      ...over,
    });
}

async function session() {
  await db(env)
    .insert(schema.sessions)
    .values({
      id: SESSION_ID,
      kind: "one_off",
      gameDayId: DAY_ID,
      startsAt: START,
      endsAt: START + 18_000,
    });
  return (await loadProjectionTarget(env, SESSION_ID))!;
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

function sessionRow() {
  return db(env).select().from(schema.sessions).where(eq(schema.sessions.id, SESSION_ID)).get();
}

beforeEach(async () => {
  calls = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    const path = url.pathname.replace("/api/v10", "");
    calls.push({
      method: init?.method ?? "GET",
      path,
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
    });
    if (path.endsWith("/threads")) return Response.json({ id: "session-thread" });
    return Response.json({ id: `msg-${calls.length}`, channel_id: "chan-1" });
  }) as typeof fetch;

  for (const table of [
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
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("who the post asks", () => {
  it("lists every seated player as not heard from", async () => {
    await day();
    const ids = await people(3);
    for (const id of ids) await claimSeat(env, DAY_ID, id);
    await session();

    const rows = await attendanceRows(env, SESSION_ID);
    expect(rows).toEqual([
      { userId: "p0", name: "Player p0", intent: null, note: null },
      { userId: "p1", name: "Player p1", intent: null, note: null },
      { userId: "p2", name: "Player p2", intent: null, note: null },
    ]);
  });

  it("does not ask the waitlist", async () => {
    await day({ capacity: 2 });
    const ids = await people(4);
    for (const id of ids) await claimSeat(env, DAY_ID, id);
    await session();

    // The queue behind the table is not the table. Listing somebody with no seat
    // as "not heard from" asks them a question nobody put to them.
    expect((await attendanceRows(env, SESSION_ID)).map((row) => row.userId)).toEqual(["p0", "p1"]);
  });

  it("keeps an answer from somebody who has since given the seat back", async () => {
    await day();
    const ids = await people(2);
    for (const id of ids) await claimSeat(env, DAY_ID, id);
    await session();
    await db(env)
      .insert(schema.attendance)
      .values({ sessionId: SESSION_ID, userId: ids[0]!, intent: "in" });
    await withdraw(env, DAY_ID, ids[0]!);

    // They answered, and that answer is still true of them.
    const rows = await attendanceRows(env, SESSION_ID);
    expect(rows).toMatchObject([{ userId: "p0", intent: "in" }, { userId: "p1", intent: null }]);
  });

  it("shows somebody promoted after the post existed, on the next render", async () => {
    await day({ capacity: 1 });
    const ids = await people(2);
    for (const id of ids) await claimSeat(env, DAY_ID, id);
    await session();
    expect((await attendanceRows(env, SESSION_ID)).map((row) => row.userId)).toEqual(["p0"]);

    await withdraw(env, DAY_ID, ids[0]!);
    await promoteFromWaitlist(env, DAY_ID);

    // No edit of the old post — a fresh render is how a snapshot becomes current.
    expect((await attendanceRows(env, SESSION_ID)).map((row) => row.userId)).toEqual(["p1"]);
  });

  it("leaves a campaign session's roster exactly as it was", async () => {
    await db(env)
      .insert(schema.campaigns)
      .values({ id: "c1", name: "Age of Umbra", kind: "run", state: "RUNNING" });
    const ids = await people(2);
    for (const id of ids) {
      await db(env).insert(schema.campaignMembers).values({ campaignId: "c1", userId: id });
    }
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

    expect((await attendanceRows(env, "c1-s1")).map((row) => row.userId)).toEqual(["p0", "p1"]);
  });
});

describe("does it run", () => {
  it("takes the threshold from the game, not from a quorum column", async () => {
    await day();
    const target = await session();

    // The same number phase 4's default win rule used. A day has no `quorum`
    // column and does not need one.
    expect(requiredFor(target)).toBe(3);
  });

  it("asks nothing of a multi day", async () => {
    await day({ kind: "multi", gameId: null });
    expect(requiredFor(await session())).toBeNull();
  });

  it("asks nothing when the game has no minimum", async () => {
    await db(env).update(schema.games).set({ minPlayers: null });
    await day();
    expect(requiredFor(await session())).toBeNull();
  });

  it("trips jeopardy at the game's minimum", async () => {
    await day();
    const ids = await people(2);
    for (const id of ids) await claimSeat(env, DAY_ID, id);
    const target = await session();
    for (const id of ids) {
      await db(env)
        .insert(schema.attendance)
        .values({ sessionId: SESSION_ID, userId: id, intent: "in" });
    }

    expect(await checkJeopardy(env, (await loadProjectionTarget(env, SESSION_ID))!)).toBe(
      "in-jeopardy",
    );
    expect(quorumOf(target, await attendanceRows(env, SESSION_ID)).required).toBe(3);
  });

  it("confirms one that reaches it", async () => {
    await day();
    const ids = await people(3);
    for (const id of ids) await claimSeat(env, DAY_ID, id);
    await session();
    for (const id of ids) {
      await db(env)
        .insert(schema.attendance)
        .values({ sessionId: SESSION_ID, userId: id, intent: "in" });
    }

    expect(await checkJeopardy(env, (await loadProjectionTarget(env, SESSION_ID))!)).toBe(
      "confirmed",
    );
  });

  it("says nothing about a multi day, however few are in", async () => {
    await day({ kind: "multi", gameId: null });
    await session();
    expect(await checkJeopardy(env, (await loadProjectionTarget(env, SESSION_ID))!)).toBe(
      "no-quorum-set",
    );
  });
});

describe("where the post goes", () => {
  it("into the day's thread, not the scheduling channel", async () => {
    await setSetting(env, SETTING_KEYS.schedulingChannelId, "chan-scheduling");
    await day();
    const ids = await people(2);
    for (const id of ids) await claimSeat(env, DAY_ID, id);
    await session();

    await postAttendancePost(env, SESSION_ID);

    expect(calls).toMatchObject([{ method: "POST", path: "/channels/day-thread/messages" }]);
    expect(calls[0]?.body?.content).toContain("Blades in the Dark");
  });

  it("opens no second thread — the day already has one", async () => {
    await day();
    await session();
    await postAttendancePost(env, SESSION_ID);
    calls = [];

    expect(await startSessionThread(env, (await loadProjectionTarget(env, SESSION_ID))!)).toBe(
      "day-thread",
    );

    // Discord has no thread inside a thread, and two threads about one evening
    // is one too many. Recording it is what sends every later notice there.
    expect(calls).toEqual([]);
    expect(await sessionRow()).toMatchObject({ threadId: "day-thread" });
  });

  it("posts and threads in one drain, using the day's thread throughout", async () => {
    await day();
    await session();
    await db(env)
      .insert(schema.jobs)
      .values({
        id: `session.post-attendance:${SESSION_ID}`,
        kind: "session.post-attendance",
        payload: { sessionId: SESSION_ID },
        idempotencyKey: `session.post-attendance:${SESSION_ID}`,
        runAt: sql`(unixepoch())`,
      });

    await drainJobs(env);

    expect(calls.map((call) => call.path)).toEqual(["/channels/day-thread/messages"]);
    expect(await sessionRow()).toMatchObject({ threadId: "day-thread" });
  });

  it("falls back to the day's channel when it has no thread yet", async () => {
    await day({ threadId: null });
    await session();

    await postAttendancePost(env, SESSION_ID);

    expect(calls[0]?.path).toBe("/channels/chan-1/messages");
  });

  it("leaves a campaign session's post in its channel", async () => {
    await db(env)
      .insert(schema.campaigns)
      .values({
        id: "c1",
        name: "Age of Umbra",
        kind: "run",
        state: "RUNNING",
        discordChannelId: "chan-campaign",
      });
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

    await postAttendancePost(env, "c1-s1");

    // Its post is the message its thread hangs off, so it goes in the channel.
    expect(calls[0]?.path).toBe("/channels/chan-campaign/messages");
  });
});
