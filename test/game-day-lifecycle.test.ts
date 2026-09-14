import { env } from "cloudflare:test";
import { asc, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { db, schema } from "../src/db/index.ts";
import { hasExactlyOneParent } from "../src/db/schema.ts";
import { ASSUME_JOB } from "../src/attendance/assume.ts";
import { POST_SIGNUP_JOB } from "../src/game-days/post.ts";
import {
  IllegalDayTransition,
  isSeating,
  sessionIdFor,
  transition,
} from "../src/game-days/lifecycle.ts";

/**
 * The lifecycle as one function.
 *
 * `PROPOSED → SEATING` is the one that does work: it mints the day's session and
 * arms the jobs that put it on a calendar. Everything else is a state write and
 * an audit row — which is still the point, because there is no other way to move
 * a day and therefore no way to move one without leaving the record.
 */
const START = Date.parse("2026-11-07T18:00:00Z") / 1000;
const DAY_ID = "day-1";

async function day(over: Partial<typeof schema.gameDays.$inferInsert> = {}) {
  await db(env)
    .insert(schema.gameDays)
    .values({
      id: DAY_ID,
      kind: "single",
      gameId: "blades",
      startsAt: START,
      endsAt: START + 18_000,
      venue: "The Wreck",
      discordChannelId: "chan-1",
      ...over,
    });
  return DAY_ID;
}

function dayRow() {
  return db(env).select().from(schema.gameDays).where(eq(schema.gameDays.id, DAY_ID)).get();
}

function sessions() {
  return db(env).select().from(schema.sessions).all();
}

function jobs() {
  return db(env).select().from(schema.jobs).orderBy(asc(schema.jobs.id)).all();
}

function audit() {
  return db(env).select().from(schema.auditLog).all();
}

beforeEach(async () => {
  for (const table of [
    "audit_log",
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
  await db(env)
    .insert(schema.games)
    .values({ id: "blades", name: "Blades in the Dark", minPlayers: 3, maxPlayers: 4 });
  await db(env)
    .insert(schema.users)
    .values({ discordId: "organiser", username: "org", feedToken: "t-org" });
});

describe("opening seating", () => {
  it("mints exactly one session, hanging off the day and no campaign", async () => {
    await day();

    const result = await transition(env, DAY_ID, "SEATING", "organiser");

    expect(result).toMatchObject({ from: "PROPOSED", to: "SEATING", changed: true });
    const [session] = await sessions();
    expect(session).toMatchObject({
      id: sessionIdFor(DAY_ID),
      kind: "one_off",
      gameDayId: DAY_ID,
      campaignId: null,
      startsAt: START,
      endsAt: START + 18_000,
    });
    // The rule `p5/2` moved out of a CHECK, checked where it belongs.
    expect(hasExactlyOneParent(session!)).toBe(true);
  });

  it("does not mint a second one when it is run again", async () => {
    await day();
    await transition(env, DAY_ID, "SEATING", "organiser");
    // A half-finished transition is meant to be simply run again, so the second
    // run has to be a no-op rather than a second evening.
    await db(env)
      .update(schema.gameDays)
      .set({ state: "PROPOSED" })
      .where(eq(schema.gameDays.id, DAY_ID));

    await transition(env, DAY_ID, "SEATING", "organiser");

    expect(await sessions()).toHaveLength(1);
  });

  it("arms the projection and the signup post, and the register for afterwards", async () => {
    await day();
    await transition(env, DAY_ID, "SEATING", "organiser");

    const sessionId = sessionIdFor(DAY_ID);
    expect((await jobs()).map((job) => [job.kind, job.id])).toEqual([
      [ASSUME_JOB, `${ASSUME_JOB}:${sessionId}`],
      [POST_SIGNUP_JOB, `${POST_SIGNUP_JOB}:${DAY_ID}`],
      ["session.project", `session.project:${sessionId}`],
    ]);
    expect((await jobs()).find((job) => job.kind === ASSUME_JOB)?.runAt).toBe(START + 18_000);
  });

  it("arms no lock job — that is the PR above this one", async () => {
    await day();
    await transition(env, DAY_ID, "SEATING", "organiser");

    // Arming a job kind `runJob` does not know is how a row retries into
    // `last_error` until the handler lands.
    expect((await jobs()).some((job) => job.kind === "game-day.lock")).toBe(false);
  });

  it("does not write a second set of jobs on a replay", async () => {
    await day();
    await transition(env, DAY_ID, "SEATING", "organiser");
    const before = await jobs();
    await db(env)
      .update(schema.gameDays)
      .set({ state: "PROPOSED" })
      .where(eq(schema.gameDays.id, DAY_ID));

    await transition(env, DAY_ID, "SEATING", "organiser");

    expect(await jobs()).toHaveLength(before.length);
  });

  it("says the day is seating afterwards", async () => {
    await day();
    await transition(env, DAY_ID, "SEATING", "organiser");
    expect(isSeating((await dayRow())!)).toBe(true);
  });
});

describe("the record", () => {
  it("writes who moved it, in the same batch as the move", async () => {
    await day();
    await transition(env, DAY_ID, "SEATING", "organiser");

    expect(await audit()).toMatchObject([
      {
        actorUserId: "organiser",
        action: "gameday.transition",
        targetType: "game_day",
        targetId: DAY_ID,
        detail: { before: "PROPOSED", after: "SEATING" },
      },
    ]);
  });

  it("takes null for the clock rather than inventing an actor", async () => {
    await day({ state: "SEATING" });
    await transition(env, DAY_ID, "LOCKED");

    expect((await audit())[0]).toMatchObject({ actorUserId: null });
  });

  it("writes nothing at all when the day is already there", async () => {
    await day({ state: "SEATING" });

    expect(await transition(env, DAY_ID, "SEATING", "organiser")).toMatchObject({
      changed: false,
    });
    // A double-click is not an error and it is not history either.
    expect(await audit()).toEqual([]);
    expect(await sessions()).toEqual([]);
  });
});

describe("the moves it refuses", () => {
  it("will not go back to seating once locked", async () => {
    await day({ state: "LOCKED" });

    await expect(transition(env, DAY_ID, "SEATING", "organiser")).rejects.toThrow(
      IllegalDayTransition,
    );
    // Locking is how the table stops moving, and a table that can be un-stopped
    // by a click never really stopped.
    expect(await dayRow()).toMatchObject({ state: "LOCKED" });
    expect(await jobs()).toEqual([]);
    expect(await audit()).toEqual([]);
  });

  it("will not move a played day at all", async () => {
    await day({ state: "PLAYED" });
    for (const to of ["SEATING", "LOCKED", "CANCELLED"] as const) {
      await expect(transition(env, DAY_ID, to, "organiser")).rejects.toThrow(IllegalDayTransition);
    }
  });

  it("will not un-cancel one", async () => {
    await day({ state: "CANCELLED" });
    await expect(transition(env, DAY_ID, "SEATING", "organiser")).rejects.toThrow(
      IllegalDayTransition,
    );
  });

  it("will not skip seating on the way to locked", async () => {
    await day();
    await expect(transition(env, DAY_ID, "LOCKED", "organiser")).rejects.toThrow(
      IllegalDayTransition,
    );
  });

  it("throws for a day that is not there", async () => {
    await expect(transition(env, "nowhere", "SEATING", "organiser")).rejects.toThrow(
      "no game day nowhere",
    );
  });
});

describe("calling it off", () => {
  it("is reachable from every state before played", async () => {
    for (const from of ["PROPOSED", "SEATING", "LOCKED"] as const) {
      await env.DB.prepare("DELETE FROM game_days").run();
      await env.DB.prepare("DELETE FROM sessions").run();
      await day({ state: from });

      expect(await transition(env, DAY_ID, "CANCELLED", "organiser")).toMatchObject({
        from,
        to: "CANCELLED",
        changed: true,
      });
    }
  });

  it("mints no session on the way out", async () => {
    await day();
    await transition(env, DAY_ID, "CANCELLED", "organiser");
    expect(await sessions()).toEqual([]);
  });
});
