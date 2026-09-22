import { env } from "cloudflare:test";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db, schema } from "../src/db/index.ts";
import { SETTING_KEYS, setSetting } from "../src/db/settings.ts";
import { seedStatements } from "../src/db/seed-sql.ts";
import { drainJobs } from "../src/jobs/drain.ts";
import { loadProjectionTarget } from "../src/projection/target.ts";
import { armAssume, assumeAttendance, attendedFrom } from "../src/attendance/assume.ts";

/**
 * Nobody ticks a register at a table, so Orrey assumes — and marks the
 * assumption as one. What is worth testing is what it refuses to overwrite.
 */
const realFetch = globalThis.fetch;
const SESSION_ID = "age-of-umbra-s12";
const STARTS_AT = Date.parse("2026-09-20T19:00:00Z") / 1000;
const ENDS_AT = STARTS_AT + 4 * 3600;

const campaign = {
  name: "Age of Umbra",
  kind: "run",
  discordChannelId: "chan-1",
  discordRoleId: "role-1",
} as const;

const session = { number: 12, startsAt: STARTS_AT, endsAt: ENDS_AT, location: "The Wreck" };

async function target() {
  return (await loadProjectionTarget(env, SESSION_ID))!;
}

async function member(id: string, intent: "in" | "out" | "maybe" | null) {
  await db(env)
    .insert(schema.users)
    .values({ discordId: id, username: id, feedToken: `t-${id}` })
    .onConflictDoNothing();
  await db(env)
    .insert(schema.campaignMembers)
    // Joined the day before the session, rather than whenever these tests run.
    // `joinedAt` defaults to now and flake memory only counts sessions played
    // since somebody joined — so with a fixture date in the past, a member added
    // here had joined *after* the evening and the register said nothing about
    // them. That is a window this file never meant to be testing.
    .values({ campaignId: "age-of-umbra", userId: id, joinedAt: STARTS_AT - 86_400 });
  if (intent !== null) {
    await db(env)
      .insert(schema.attendance)
      .values({ sessionId: SESSION_ID, userId: id, intent });
  }
}

function register(userId: string) {
  return db(env)
    .select()
    .from(schema.attendance)
    .where(
      and(eq(schema.attendance.sessionId, SESSION_ID), eq(schema.attendance.userId, userId)),
    )
    .get();
}

function stateOf() {
  return db(env)
    .select({ state: schema.sessions.state })
    .from(schema.sessions)
    .where(eq(schema.sessions.id, SESSION_ID))
    .get()
    .then((row) => row?.state);
}

beforeEach(async () => {
  globalThis.fetch = (async () =>
    Response.json({ id: "msg-1", channel_id: "chan-1" })) as typeof fetch;

  for (const table of ["publications", "attendance", "campaign_members", "jobs", "sessions", "campaigns", "users", "settings"]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  await setSetting(env, SETTING_KEYS.guildId, "g1");
  for (const statement of seedStatements(campaign, session)) {
    await env.DB.prepare(statement).run();
  }
  await env.DB.prepare("DELETE FROM jobs").run();
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("what is assumed", () => {
  it("takes `in` as turned up and everything else as did not, where a count decides", () => {
    expect(attendedFrom("in", "quorum")).toBe(true);
    expect(attendedFrom("out", "quorum")).toBe(false);
    expect(attendedFrom(null, "quorum")).toBe(false);
    // #31 calls `maybe` the organiser's call and defaults it to 0. An assumption
    // that somebody *did* turn up is invisible when it is wrong; an assumption
    // they did not is a toggle the organiser can see and flip.
    expect(attendedFrom("maybe", "quorum")).toBe(false);
  });

  it("takes anything but an `out` as turned up, where silence was an answer", () => {
    // The same reasoning as above, applied to a rule where silence means the
    // opposite thing: the post said in as many words that silence counts as in.
    // Writing down that everybody who took it at its word was absent is not the
    // cautious assumption, it is the wrong one — and since nearly every roster is
    // nearly always silent, it is wrong about nearly everybody on every session.
    expect(attendedFrom("in", "unanimous")).toBe(true);
    expect(attendedFrom(null, "unanimous")).toBe(true);
    expect(attendedFrom("maybe", "unanimous")).toBe(true);
    expect(attendedFrom("out", "unanimous")).toBe(false);
  });

  it("writes the register and marks the session played", async () => {
    await member("said-in", "in");
    await member("said-out", "out");
    await member("said-maybe", "maybe");
    await member("silent", null);

    await assumeAttendance(env, await target());

    // Four roster members and no quorum set, so the evening ran under the veto
    // rule and everybody who did not say `out` was there.
    expect(await register("said-in")).toMatchObject({ attended: 1, attendedSource: "auto" });
    expect(await register("said-out")).toMatchObject({ attended: 0, attendedSource: "auto" });
    expect(await register("said-maybe")).toMatchObject({ attended: 1, attendedSource: "auto" });
    expect(await register("silent")).toMatchObject({ attended: 1, attendedSource: "auto" });
    expect(await stateOf()).toBe("PLAYED");
  });

  it("takes only the `in` rows where the campaign asked for a count", async () => {
    await db(env)
      .update(schema.campaigns)
      .set({ quorum: 3 })
      .where(eq(schema.campaigns.id, "age-of-umbra"));
    await member("said-in", "in");
    await member("said-maybe", "maybe");
    await member("silent", null);

    await assumeAttendance(env, await target());

    // Setting a quorum is opting back into counting, and under a count silence is
    // a question nobody answered rather than a yes.
    expect(await register("said-in")).toMatchObject({ attended: 1 });
    expect(await register("said-maybe")).toMatchObject({ attended: 0 });
    expect(await register("silent")).toMatchObject({ attended: 0 });
  });

  it("writes a row for a roster member who never clicked anything", async () => {
    await member("silent", null);

    await assumeAttendance(env, await target());

    // A register full of nulls is a register nobody filled in, and flake memory
    // reads these numbers.
    expect(await register("silent")).toMatchObject({ attended: 1, intent: null });
  });

  it("does not turn silence into a no-show streak", async () => {
    const { flakeFor } = await import("../src/campaigns/flake.ts");
    await member("silent", null);

    await assumeAttendance(env, await target());

    // Marked present, and marked `auto`. The streak counts "said in and did not
    // show" and nothing else, so a roster the rule counted in cannot accumulate
    // one by staying quiet — which is the statistic this change had to not break.
    expect(await flakeFor(env, "age-of-umbra", "silent")).toMatchObject({
      played: 1,
      attended: 1,
      noShowStreak: 0,
    });
  });

  it("never overwrites what the organiser said", async () => {
    await member("corrected", "out");
    await db(env)
      .update(schema.attendance)
      .set({ attended: 1, attendedSource: "gm" })
      .where(eq(schema.attendance.userId, "corrected"));

    await assumeAttendance(env, await target());

    // An organiser who corrected the register before the job ran — or before a
    // re-run — must not have their answer replaced by an assumption.
    expect(await register("corrected")).toMatchObject({ attended: 1, attendedSource: "gm" });
  });

  it("is safe to run twice", async () => {
    await member("a", "in");
    await assumeAttendance(env, await target());
    await assumeAttendance(env, await target());

    expect(await db(env).select().from(schema.attendance).all()).toHaveLength(1);
    expect(await stateOf()).toBe("PLAYED");
  });

  it("leaves a cancelled session alone", async () => {
    await member("a", "in");
    await env.DB.prepare("UPDATE sessions SET state = 'CANCELLED'").run();

    expect(await assumeAttendance(env, await target())).toEqual([]);
    expect(await register("a")).toMatchObject({ attended: null });
    expect(await stateOf()).toBe("CANCELLED");
  });

  it("marks an empty session played rather than leaving it hanging", async () => {
    expect(await assumeAttendance(env, await target())).toEqual([]);
    expect(await stateOf()).toBe("PLAYED");
  });
});

describe("arming it", () => {
  it("puts the job at the moment the session ends", async () => {
    await armAssume(env, SESSION_ID, ENDS_AT);

    expect(
      await db(env).select().from(schema.jobs).where(eq(schema.jobs.kind, "attendance.assume")).get(),
    ).toMatchObject({ runAt: ENDS_AT, state: "pending" });
  });

  it("moves with the session", async () => {
    await armAssume(env, SESSION_ID, ENDS_AT);
    await armAssume(env, SESSION_ID, ENDS_AT + 86_400);

    const rows = await db(env).select().from(schema.jobs).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.runAt).toBe(ENDS_AT + 86_400);
  });

  it("runs on the drain when its time comes", async () => {
    await member("a", "in");
    await armAssume(env, SESSION_ID, Math.floor(Date.now() / 1000) - 60);

    await drainJobs(env);

    expect(await stateOf()).toBe("PLAYED");
    expect(await register("a")).toMatchObject({ attended: 1 });
  });
});
