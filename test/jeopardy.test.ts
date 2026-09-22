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

async function roster(gm: string, players: string[]) {
  for (const id of [gm, ...players]) {
    await db(env)
      .insert(schema.users)
      .values({ discordId: id, username: `u${id}`, feedToken: `tok${id}` })
      .onConflictDoNothing();
  }
  await db(env)
    .insert(schema.campaignMembers)
    .values([
      { campaignId: "age-of-umbra", userId: gm, role: "gm", joinedAt: 1 },
      ...players.map((id, i) => ({
        campaignId: "age-of-umbra",
        userId: id,
        role: "player" as const,
        joinedAt: 2 + i,
      })),
    ]);
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

let posted: { path: string; body: Record<string, unknown> }[] = [];

beforeEach(async () => {
  posted = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    posted.push({
      path: url.pathname.replace("/api/v10", ""),
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
    });
    return Response.json({ id: `msg-${posted.length}`, channel_id: "chan-1" });
  }) as typeof fetch;

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

  it("says nothing when the objection was taken back before the drain ran", async () => {
    await setQuorum(null);
    await roster("gm-1", ["p-1"]);
    await db(env)
      .insert(schema.attendance)
      .values({ sessionId: SESSION_ID, userId: "p-1", intent: "out" });
    await armJeopardyCheck(env, SESSION_ID, Math.floor(Date.now() / 1000) + 3600);
    await checkJeopardy(env, await target());

    // Marked, and then withdrawn before the notice went out. The notice keys on
    // the rule rather than the outcome, so it used to take the veto branch anyway
    // and announce "0 of 1 cannot make it".
    await db(env)
      .update(schema.attendance)
      .set({ intent: "in" })
      .where(eq(schema.attendance.userId, "p-1"));
    posted = [];

    await drainJobs(env);

    expect(posted).toEqual([]);
  });

  it("tells the table again when a second date is vetoed too", async () => {
    await setQuorum(null);
    await roster("gm-1", ["p-1"]);
    await db(env)
      .insert(schema.attendance)
      .values({ sessionId: SESSION_ID, userId: "p-1", intent: "out" });

    await armJeopardyCheck(env, SESSION_ID, Math.floor(Date.now() / 1000) + 3600);
    await drainJobs(env);
    const first = posted.length;

    // The evening moves, and the new date does not work either. A session-scoped
    // claim meant the table was told once and never again, however many dates the
    // campaign worked through.
    const moved = STARTS_AT + 7 * 86_400;
    await db(env)
      .update(schema.sessions)
      .set({ startsAt: moved, endsAt: moved + 4 * 3600, state: "SCHEDULED" })
      .where(eq(schema.sessions.id, SESSION_ID));
    await armJeopardyCheck(env, SESSION_ID, Math.floor(Date.now() / 1000) + 3600);
    await drainJobs(env);

    expect(first).toBeGreaterThan(0);
    expect(posted.length).toBeGreaterThan(first);
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

  it("still answers in-jeopardy for a session it already marked", async () => {
    await saidIn(1);
    await db(env)
      .update(schema.sessions)
      .set({ state: "JEOPARDY" })
      .where(eq(schema.sessions.id, SESSION_ID));

    // The run that marked it may have failed to post the notice afterwards.
    // Answering "not-waiting" here would make the state write the thing that
    // enforces "once", and a single refused Discord call would lose the notice
    // for ever. The claim in postNoticeOnce is what makes it once.
    expect(await checkJeopardy(env, await target())).toBe("in-jeopardy");
  });

  it("does not overwrite a CONFIRMED written while it was reading", async () => {
    await saidIn(1);
    const stale = await target();

    // A click crossed quorum between the read and the write.
    await db(env)
      .update(schema.sessions)
      .set({ state: "CONFIRMED" })
      .where(eq(schema.sessions.id, SESSION_ID));

    await checkJeopardy(env, stale);

    // The clock loses this race on purpose: a person clicking In is newer
    // information than a tally read a moment ago.
    expect(await stateOf()).toBe("CONFIRMED");
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

describe("the notice", () => {
  it("names who has not answered, and who decides", async () => {
    await roster("gm-1", ["p-1", "p-2"]);
    await db(env)
      .insert(schema.attendance)
      .values({ sessionId: SESSION_ID, userId: "p-1", intent: "in" });
    await armJeopardyCheck(env, SESSION_ID, Math.floor(Date.now() / 1000) + 3600);

    await drainJobs(env);

    const notice = posted.at(-1)!;
    expect(notice.body.content).toContain("Is this one happening?");
    expect(notice.body.content).toContain("1 of 3 in");
    // "We are two short" is a fact nobody can act on. "…and it is these two who
    // have not said" is a fact two people can.
    expect(notice.body.content).toContain("<@p-2>");
    expect(notice.body.content).toContain("<@gm-1> decides whether it runs");
  });

  it("mentions the roster and the people it named, and nothing else", async () => {
    await roster("gm-1", ["p-1"]);
    await armJeopardyCheck(env, SESSION_ID, Math.floor(Date.now() / 1000) + 3600);

    await drainJobs(env);

    const mentions = posted.at(-1)!.body.allowed_mentions as {
      parse: string[];
      roles: string[];
      users: string[];
    };
    // A notice that could fire @everyone because somebody's display name looked
    // like one is a notice nobody trusts.
    expect(mentions.parse).toEqual([]);
    expect(mentions.roles).toEqual(["role-1"]);
    expect(mentions.users.sort()).toEqual(["gm-1", "p-1"]);
  });

  it("says nothing when the session is not in jeopardy", async () => {
    await roster("gm-1", ["p-1", "p-2"]);
    await saidIn(3);
    await armJeopardyCheck(env, SESSION_ID, Math.floor(Date.now() / 1000) + 3600);

    await drainJobs(env);

    // A notice asking whether a confirmed session is happening is worse than
    // silence.
    expect(posted).toEqual([]);
  });

  it("posts it once, however often the check runs", async () => {
    await roster("gm-1", ["p-1", "p-2"]);
    await armJeopardyCheck(env, SESSION_ID, Math.floor(Date.now() / 1000) + 3600);
    await drainJobs(env);

    await armJeopardyCheck(env, SESSION_ID, Math.floor(Date.now() / 1000) + 3600);
    await drainJobs(env);

    expect(posted).toHaveLength(1);
  });

  it("manages without a GM rather than inventing one", async () => {
    await db(env)
      .insert(schema.users)
      .values({ discordId: "p-1", username: "p", feedToken: "t" });
    await db(env)
      .insert(schema.campaignMembers)
      .values({ campaignId: "age-of-umbra", userId: "p-1" });
    await armJeopardyCheck(env, SESSION_ID, Math.floor(Date.now() / 1000) + 3600);

    await drainJobs(env);

    expect(posted.at(-1)!.body.content).toContain("Whoever is running it decides");
  });
});

/**
 * The veto rule, a day out (#173). Nothing here counts anything: the check is
 * asking whether anybody assigned to the evening has said they cannot make it.
 */
describe("what the check writes, once there is a roster", () => {
  beforeEach(async () => {
    await setQuorum(null);
  });

  it("marks a session one person on the roster cannot make", async () => {
    await roster("gm-1", ["p-1", "p-2"]);
    await db(env)
      .insert(schema.attendance)
      .values({ sessionId: SESSION_ID, userId: "p-1", intent: "out" });

    expect(await checkJeopardy(env, await target())).toBe("in-jeopardy");
    expect(await stateOf()).toBe("JEOPARDY");
  });

  it("leaves a session nobody has objected to alone", async () => {
    await roster("gm-1", ["p-1", "p-2"]);

    // Not one click, and it is on. Under this rule an unanswered post is a
    // table with nothing to say, and the clock has nothing to say about it.
    expect(await checkJeopardy(env, await target())).toBe("confirmed");
    expect(await stateOf()).toBe("SCHEDULED");
  });

  it("does not read silence as a shortfall", async () => {
    await roster("gm-1", ["p-1", "p-2"]);
    await db(env)
      .insert(schema.attendance)
      .values({ sessionId: SESSION_ID, userId: "p-1", intent: "maybe" });

    // Reading `required` before the rule made this answer `no-quorum-set` — and a
    // campaign on the veto rule was the one campaign the check could not speak
    // about at all.
    expect(await checkJeopardy(env, await target())).toBe("confirmed");
  });

  it("still never cancels anything", async () => {
    await roster("gm-1", ["p-1"]);
    await db(env)
      .insert(schema.attendance)
      .values({ sessionId: SESSION_ID, userId: "p-1", intent: "out" });

    await checkJeopardy(env, await target());

    // The rule changed; #1 did not. When the answer is no the response is a date
    // poll, and this marks the session and leaves the deciding to people.
    expect(await stateOf()).toBe("JEOPARDY");
  });

  it("finds an objection on a session that had already been confirmed", async () => {
    await roster("gm-1", ["p-1", "p-2"]);
    await db(env)
      .update(schema.sessions)
      .set({ state: "CONFIRMED" })
      .where(eq(schema.sessions.id, SESSION_ID));
    await db(env)
      .insert(schema.attendance)
      .values({ sessionId: SESSION_ID, userId: "p-1", intent: "out" });

    // CONFIRMED is settled under a count and is not under this rule — `vetoed()`
    // lists it. Answering "confirmed" without looking meant an `out` arriving from
    // the console after a confirmation was invisible to the clock, over a post
    // already reading "Can't run as it stands".
    expect(await checkJeopardy(env, await target())).toBe("in-jeopardy");
    expect(await stateOf()).toBe("JEOPARDY");
  });

  it("goes back to counting when the organiser sets a quorum", async () => {
    await setQuorum(3);
    await roster("gm-1", ["p-1", "p-2"]);
    await db(env)
      .insert(schema.attendance)
      .values({ sessionId: SESSION_ID, userId: "p-1", intent: "out" });

    // One `out` of three assigned, and two who have said nothing: short of three
    // either way, but it is the tally that found it and the notice will say so.
    expect(await checkJeopardy(env, await target())).toBe("in-jeopardy");
  });
});

describe("the notice, once there is a roster", () => {
  beforeEach(async () => {
    await setQuorum(null);
    await roster("gm-1", ["p-1", "p-2"]);
  });

  async function noticeAfterVeto(by = "p-1") {
    await db(env)
      .insert(schema.attendance)
      .values({ sessionId: SESSION_ID, userId: by, intent: "out" });
    await armJeopardyCheck(env, SESSION_ID, Math.floor(Date.now() / 1000) + 3600);
    await drainJobs(env);
    return posted.at(-1)!;
  }

  it("says the evening has to move, and names who cannot make it", async () => {
    const notice = await noticeAfterVeto();

    expect(notice.body.content).toContain("This one has to move");
    expect(notice.body.content).toContain("up-1 cannot make it");
    // There is no bar, so there is no tally to print against one.
    expect(notice.body.content).not.toMatch(/\d+ of \d+ in/);
    expect(notice.body.content).toContain("<@gm-1> decides whether it runs");
  });

  it("wakes the GM and nobody else", async () => {
    const mentions = (await noticeAfterVeto()).body.allowed_mentions as {
      parse: string[];
      roles: string[];
      users: string[];
    };

    // Under this rule silence is already a yes, so pinging everybody who has said
    // nothing would be waking the table to do nothing about an evening that is not
    // in doubt for any of them. And the person who cannot make it is named rather
    // than mentioned: the notice is here to move a date, not to put somebody on
    // the spot for having a Tuesday.
    expect(mentions.parse).toEqual([]);
    expect(mentions.roles).toEqual(["role-1"]);
    expect(mentions.users).toEqual(["gm-1"]);
  });

  it("still carries the Suggest a day button", async () => {
    const notice = await noticeAfterVeto();
    const rows = notice.body.components as { components: { custom_id: string }[] }[];

    // The next step is a date poll, so the button that opens one has to be on the
    // message that says a date has to change.
    expect(rows[0]?.components?.[0]?.custom_id).toContain("suggest");
  });

  it("goes out for a session the clock finds vetoed, not only a clicked one", async () => {
    // The whole reason the check still runs the veto rule: an `out` can reach D1
    // from the console, and somebody can be added to a roster after the post went
    // up. Neither of those is a click on the post.
    expect((await noticeAfterVeto()).path).toContain("/messages");
  });
});
