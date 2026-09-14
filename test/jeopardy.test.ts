import { env } from "cloudflare:test";
import { asc, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db, schema } from "../src/db/index.ts";
import { SETTING_KEYS, setSetting } from "../src/db/settings.ts";
import { seedStatements } from "../src/db/seed-sql.ts";
import { drainJobs } from "../src/jobs/drain.ts";
import { loadProjectionTarget } from "../src/projection/target.ts";
import { armJeopardyCheck, checkJeopardy } from "../src/attendance/jeopardy.ts";
import { materialiseHorizon } from "../src/campaigns/materialise.ts";

/**
 * Does it *still* run. The state half: what the clock writes a day out, and
 * everything it deliberately does not do.
 */
const realFetch = globalThis.fetch;
const SESSION_ID = "age-of-umbra-s12";
const STARTS_AT = Date.parse("2026-09-20T19:00:00Z") / 1000;

const campaign = {
  name: "Age of Umbra",
  kind: "run",
  discordChannelId: "chan-1",
  discordRoleId: "role-1",
} as const;

const session = {
  number: 12,
  startsAt: STARTS_AT,
  endsAt: STARTS_AT + 4 * 3600,
  location: "The Wreck",
};

async function target() {
  return (await loadProjectionTarget(env, SESSION_ID))!;
}

function stateOf(id = SESSION_ID) {
  return db(env)
    .select({ state: schema.sessions.state })
    .from(schema.sessions)
    .where(eq(schema.sessions.id, id))
    .get()
    .then((row) => row?.state);
}

function checkJob() {
  return db(env)
    .select()
    .from(schema.jobs)
    .where(eq(schema.jobs.id, `jeopardy.check:${SESSION_ID}`))
    .get();
}

async function setQuorum(quorum: number | null) {
  await db(env)
    .update(schema.campaigns)
    .set({ quorum })
    .where(eq(schema.campaigns.id, "age-of-umbra"));
}

async function saidIn(count: number) {
  for (let i = 0; i < count; i++) {
    await db(env)
      .insert(schema.users)
      .values({ discordId: `p${i}`, username: `p${i}`, feedToken: `t${i}` })
      .onConflictDoNothing();
    await db(env)
      .insert(schema.attendance)
      .values({ sessionId: SESSION_ID, userId: `p${i}`, intent: "in" });
  }
}

beforeEach(async () => {
  globalThis.fetch = (async () =>
    Response.json({ id: "msg-1", channel_id: "chan-1" })) as typeof fetch;

  for (const table of ["publications", "attendance", "jobs", "sessions", "campaigns", "users", "settings"]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  await setSetting(env, SETTING_KEYS.guildId, "g1");
  for (const statement of seedStatements(campaign, session)) {
    await env.DB.prepare(statement).run();
  }
  await env.DB.prepare("DELETE FROM jobs").run();
  await setQuorum(3);
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("arming the check", () => {
  it("puts it a day before the session, by default", async () => {
    await armJeopardyCheck(env, SESSION_ID, STARTS_AT);

    expect(await checkJob()).toMatchObject({
      kind: "jeopardy.check",
      state: "pending",
      runAt: STARTS_AT - 24 * 3600,
    });
  });

  it("takes the lead time from settings", async () => {
    await setSetting(env, SETTING_KEYS.jeopardyLeadHours, 48);
    await armJeopardyCheck(env, SESSION_ID, STARTS_AT);

    expect((await checkJob())?.runAt).toBe(STARTS_AT - 48 * 3600);
  });

  it("moves with the session rather than making a second one", async () => {
    await armJeopardyCheck(env, SESSION_ID, STARTS_AT);
    const moved = STARTS_AT + 7 * 86_400;

    await armJeopardyCheck(env, SESSION_ID, moved);

    // A check still pointing at the old time would fire a day after the wrong
    // day. Phase 4 moves sessions; this is what keeps up with it.
    expect(await db(env).select().from(schema.jobs).all()).toHaveLength(1);
    expect((await checkJob())?.runAt).toBe(moved - 24 * 3600);
  });

  it("un-fails a check that failed before the session moved", async () => {
    await armJeopardyCheck(env, SESSION_ID, STARTS_AT);
    await db(env)
      .update(schema.jobs)
      .set({ state: "failed", attempts: 3, lastError: "something" })
      .where(eq(schema.jobs.id, `jeopardy.check:${SESSION_ID}`));

    await armJeopardyCheck(env, SESSION_ID, STARTS_AT + 86_400);

    expect(await checkJob()).toMatchObject({ state: "pending", attempts: 0, lastError: null });
  });

  it("is armed for every session the materialiser makes", async () => {
    await env.DB.prepare("DELETE FROM sessions").run();
    await setSetting(env, SETTING_KEYS.horizonSessions, 2);
    await db(env)
      .update(schema.campaigns)
      .set({
        state: "RUNNING",
        recurrenceAnchor: Math.floor(Date.parse("2024-01-06T19:00:00Z") / 1000),
        intervalWeeks: 2,
      })
      .where(eq(schema.campaigns.id, "age-of-umbra"));

    await materialiseHorizon(env, new Date("2026-09-14T12:00:00Z"));

    const checks = await db(env)
      .select()
      .from(schema.jobs)
      .orderBy(asc(schema.jobs.id))
      .all()
      .then((rows) => rows.filter((row) => row.kind === "jeopardy.check"));
    expect(checks).toHaveLength(2);
  });
});

describe("what the check writes", () => {
  it("marks a session that has fallen short", async () => {
    await saidIn(2);

    expect(await checkJeopardy(env, await target())).toBe("in-jeopardy");
    expect(await stateOf()).toBe("JEOPARDY");
  });

  it("leaves a session that has quorum alone", async () => {
    await saidIn(3);

    expect(await checkJeopardy(env, await target())).toBe("confirmed");
    expect(await stateOf()).toBe("SCHEDULED");
  });

  it("says nothing about a campaign that never set a quorum", async () => {
    await setQuorum(null);
    await saidIn(0);

    // The campaign has not asked this question, and Orrey does not answer it on
    // their behalf.
    expect(await checkJeopardy(env, await target())).toBe("no-quorum-set");
    expect(await stateOf()).toBe("SCHEDULED");
  });

  it("leaves a confirmed session confirmed, however few are in now", async () => {
    await db(env)
      .update(schema.sessions)
      .set({ state: "CONFIRMED" })
      .where(eq(schema.sessions.id, SESSION_ID));

    expect(await checkJeopardy(env, await target())).toBe("confirmed");
    expect(await stateOf()).toBe("CONFIRMED");
  });

  it("never cancels anything", async () => {
    await saidIn(0);
    await checkJeopardy(env, await target());

    // When the answer is no, the response is a date poll — phase 4's — not a
    // cancellation. Orrey marks it and leaves the deciding to people.
    expect(await stateOf()).toBe("JEOPARDY");
    expect(await stateOf()).not.toBe("CANCELLED");
  });

  it("does nothing at all to a session that is already over", async () => {
    await db(env)
      .update(schema.sessions)
      .set({ state: "PLAYED" })
      .where(eq(schema.sessions.id, SESSION_ID));

    expect(await checkJeopardy(env, await target())).toBe("not-waiting");
    expect(await stateOf()).toBe("PLAYED");
  });
});

describe("the drain", () => {
  it("runs the check when its time comes", async () => {
    await saidIn(1);
    await armJeopardyCheck(env, SESSION_ID, Math.floor(Date.now() / 1000) + 3600);

    await drainJobs(env);

    expect(await stateOf()).toBe("JEOPARDY");
    expect((await checkJob())?.state).toBe("done");
  });

  it("acks a check for a session that is gone", async () => {
    await armJeopardyCheck(env, SESSION_ID, Math.floor(Date.now() / 1000) + 3600);
    await env.DB.prepare("DELETE FROM sessions").run();

    await drainJobs(env);

    expect((await checkJob())?.state).toBe("done");
  });
});
