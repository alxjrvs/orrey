import { env } from "cloudflare:test";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db, schema } from "../src/db/index.ts";
import { SETTING_KEYS, setSetting } from "../src/db/settings.ts";
import { seedStatements } from "../src/db/seed-sql.ts";
import { drainJobs } from "../src/jobs/drain.ts";
import { SESSION_VETOED } from "../src/db/audit.ts";
import { decide } from "../src/polls/win-rule.ts";
import {
  PROPOSED_DAYS,
  RESCHEDULE_JOB,
  WHOLE_ROSTER_THRESHOLD,
  openRescheduleFor,
  proposalsFor,
} from "../src/polls/reschedule.ts";

/**
 * What happens when one person cannot make it (#173).
 *
 * Not a cancellation — #1 is explicit that the response to "no" is a date poll,
 * and the veto rule changed what counts as no rather than what follows it. So
 * every test here is about a question going up, and none is about a session
 * coming off.
 */
const realFetch = globalThis.fetch;
const SESSION_ID = "age-of-umbra-s12";

/**
 * Ten days out, off the real clock. The proposals are the days *after* the one
 * that fell through and anything already past is skipped, so a fixture dated in
 * this file would propose nothing the moment the date went by — which is the clock
 * bomb `p8/0` had just finished removing from another file.
 */
const STARTS_AT = Math.floor(Date.now() / 1000) + 10 * 86_400;

const campaign = {
  name: "Age of Umbra",
  kind: "run",
  discordChannelId: "chan-1",
  discordRoleId: "role-1",
} as const;

const session = {
  number: 12,
  startsAt: STARTS_AT,
  endsAt: STARTS_AT + 3 * 3600,
  location: "The Wreck",
};

let posted: { path: string; body: Record<string, unknown> }[] = [];

function lock() {
  return env.SESSION_LOCK.get(env.SESSION_LOCK.idFromName(SESSION_ID));
}

function stateOf() {
  return db(env)
    .select({ state: schema.sessions.state })
    .from(schema.sessions)
    .where(eq(schema.sessions.id, SESSION_ID))
    .get()
    .then((row) => row?.state);
}

function rescheduleJob() {
  return db(env)
    .select()
    .from(schema.jobs)
    .where(eq(schema.jobs.id, `${RESCHEDULE_JOB}:${SESSION_ID}`))
    .get();
}

function polls() {
  return db(env).select().from(schema.datePolls).all();
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
      { campaignId: "age-of-umbra", userId: gm, role: "gm" as const, joinedAt: 1 },
      ...players.map((id, i) => ({
        campaignId: "age-of-umbra",
        userId: id,
        role: "player" as const,
        joinedAt: 2 + i,
      })),
    ]);
}

const actor = (id: string) => ({ id, username: `u${id}`, global_name: null });

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

  for (const table of [
    "publications",
    "poll_responses",
    "poll_dates",
    "date_polls",
    "attendance",
    "audit_log",
    "jobs",
    "sessions",
    "campaigns",
    "users",
    "settings",
  ]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  await setSetting(env, SETTING_KEYS.guildId, "g1");
  await setSetting(env, SETTING_KEYS.timezone, "America/New_York");
  for (const statement of seedStatements(campaign, session)) {
    await env.DB.prepare(statement).run();
  }
  await env.DB.prepare("DELETE FROM jobs").run();
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("the days it proposes", () => {
  it("is the handful after the one that did not work, at the same time", () => {
    const dates = proposalsFor(
      { startsAt: STARTS_AT, endsAt: STARTS_AT + 3600 },
      { timezone: "America/New_York", now: new Date() },
    );

    expect(dates).toHaveLength(PROPOSED_DAYS);
    expect(dates[0]?.startsAt).toBe(STARTS_AT + 86_400);
    // The duration is the session's own, not a guess.
    expect(dates[0]!.endsAt - dates[0]!.startsAt).toBe(3600);
  });

  it("keeps the time of day across a change of clocks", () => {
    // Saturday 31 October 2026, 20:30 in New York. The clocks go back on the 1st.
    const saturday = Date.parse("2026-10-31T20:30:00-04:00") / 1000;
    const dates = proposalsFor(
      { startsAt: saturday, endsAt: saturday + 3600 },
      { timezone: "America/New_York", now: new Date("2026-10-25T00:00:00Z") },
    );

    const read = (at: number) =>
      new Date(at * 1000).toLocaleString("en-GB", {
        timeZone: "America/New_York",
        weekday: "short",
        hour: "2-digit",
        minute: "2-digit",
      });

    // A reschedule that moved a game to 19:30 because the clocks went back would
    // be the bug `src/campaigns/recurrence.ts` exists to avoid, in a new place.
    expect(read(dates[0]!.startsAt)).toContain("20:30");
    expect(read(dates[1]!.startsAt)).toContain("20:30");
    // The proof, and it is on the first step rather than between the proposals:
    // the change lands in the night between Saturday and Sunday, so Sunday's
    // 20:30 is twenty-five hours of real time after Saturday's and Monday's is a
    // plain twenty-four after that.
    expect(dates[0]!.startsAt - saturday).toBe(25 * 3600);
    expect(dates[1]!.startsAt - dates[0]!.startsAt).toBe(24 * 3600);
  });

  it("skips days that have already gone", () => {
    const dates = proposalsFor(
      { startsAt: STARTS_AT, endsAt: STARTS_AT + 3600 },
      // A job retried three days after the evening it was about.
      { timezone: "America/New_York", now: new Date((STARTS_AT + 3 * 86_400) * 1000) },
    );

    // A poll whose first option is yesterday is a poll nobody can answer
    // honestly.
    expect(dates).toHaveLength(1);
    expect(dates[0]?.startsAt).toBeGreaterThan((STARTS_AT + 3 * 86_400) * 1000 / 1000);
  });
});

describe("the click that vetoes", () => {
  beforeEach(async () => {
    await roster("gm-1", ["p-1", "p-2"]);
  });

  it("marks the session and arms the reschedule in one go", async () => {
    await lock().setIntent({ sessionId: SESSION_ID, actor: actor("p-1"), intent: "out" });

    expect(await stateOf()).toBe("JEOPARDY");
    expect(await rescheduleJob()).toMatchObject({
      kind: RESCHEDULE_JOB,
      state: "pending",
      payload: { sessionId: SESSION_ID, by: "p-1" },
    });
  });

  it("writes down whose decision it was", async () => {
    await lock().setIntent({ sessionId: SESSION_ID, actor: actor("p-1"), intent: "out" });

    const [row] = await db(env)
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, SESSION_VETOED))
      .all();

    // Unlike a confirmation, this *was* somebody's decision. It is the row that
    // explains a JEOPARDY nothing counted its way into.
    expect(row).toMatchObject({ actorUserId: "p-1", targetId: SESSION_ID });
  });

  it("does not cancel it", async () => {
    await lock().setIntent({ sessionId: SESSION_ID, actor: actor("p-1"), intent: "out" });
    expect(await stateOf()).not.toBe("CANCELLED");
  });

  it("ignores an out from somebody the session is not for", async () => {
    await db(env)
      .insert(schema.users)
      .values({ discordId: "stranger", username: "stranger", feedToken: "tok-s" });

    await lock().setIntent({ sessionId: SESSION_ID, actor: actor("stranger"), intent: "out" });

    expect(await stateOf()).toBe("SCHEDULED");
    expect(await rescheduleJob()).toBeUndefined();
  });

  it("arms nothing for a campaign that counts instead", async () => {
    await db(env)
      .update(schema.campaigns)
      .set({ quorum: 3 })
      .where(eq(schema.campaigns.id, "age-of-umbra"));

    await lock().setIntent({ sessionId: SESSION_ID, actor: actor("p-1"), intent: "out" });

    // Under a quorum an `out` is simply not an `in`, and being short is a question
    // asked of the table rather than an answer.
    expect(await stateOf()).toBe("SCHEDULED");
    expect(await rescheduleJob()).toBeUndefined();
  });

  it("acts on a session that was already marked, because a moved one still is", async () => {
    await db(env)
      .update(schema.sessions)
      .set({ state: "JEOPARDY" })
      .where(eq(schema.sessions.id, SESSION_ID));

    await lock().setIntent({ sessionId: SESSION_ID, actor: actor("p-1"), intent: "out" });

    // `moveSession` changes the date and not the state, so a session that has been
    // rescheduled once is still JEOPARDY. Refusing here would give a campaign
    // exactly one reschedule, ever.
    expect(await rescheduleJob()).toBeDefined();
  });
});

describe("the poll it opens", () => {
  beforeEach(async () => {
    await roster("gm-1", ["p-1", "p-2"]);
  });

  async function veto(by = "p-1") {
    await lock().setIntent({ sessionId: SESSION_ID, actor: actor(by), intent: "out" });
    await drainJobs(env);
  }

  it("asks the session's own table, on the days around the one that fell through", async () => {
    await veto();

    const [poll] = await polls();
    expect(poll).toMatchObject({
      targetSessionId: SESSION_ID,
      campaignId: "age-of-umbra",
      status: "open",
      openedBy: "p-1",
    });

    const dates = await db(env)
      .select()
      .from(schema.pollDates)
      .where(eq(schema.pollDates.pollId, poll!.id))
      .all();
    expect(dates).toHaveLength(PROPOSED_DAYS);
  });

  it("wins only on a date the whole roster can make", async () => {
    await veto();
    const [poll] = await polls();

    expect(poll).toMatchObject({
      winRule: "quorum_of_roster",
      winThreshold: WHOLE_ROSTER_THRESHOLD,
    });

    // Which is what that rule and that threshold mean, for a table of three: a
    // date two of them can make is a date the game would have to move off again.
    const tallies = [
      { pollDateId: "a", yes: 3 },
      { pollDateId: "b", yes: 2 },
    ];
    expect(
      decide({ rule: "quorum_of_roster", threshold: WHOLE_ROSTER_THRESHOLD, rosterSize: 3, tallies }),
    ).toMatchObject({ required: 3, won: ["a"] });
  });

  it("says in the thread why a date is being asked about", async () => {
    await veto();

    const notice = posted.find((call) =>
      String((call.body as { content?: string }).content ?? "").includes("has to move"),
    );
    expect(notice?.body.content).toContain("up-1 cannot make it");
  });

  it("opens one poll however many people say out", async () => {
    await veto("p-1");
    await lock().setIntent({ sessionId: SESSION_ID, actor: actor("p-2"), intent: "out" });
    await drainJobs(env);

    // `date_polls_one_open_per_session` is the lock, and a second veto is an
    // answer to the question the first one asked rather than a new question.
    expect(await polls()).toHaveLength(1);
  });

  it("is nothing to do for a session that has gone", async () => {
    await veto();
    await env.DB.prepare("DELETE FROM date_polls").run();
    await env.DB.prepare("DELETE FROM sessions").run();

    await db(env)
      .update(schema.jobs)
      .set({ state: "pending", claimedUntil: null })
      .where(eq(schema.jobs.id, `${RESCHEDULE_JOB}:${SESSION_ID}`));

    await drainJobs(env);

    // A refusal is not a failure: there is nothing to do rather than something to
    // retry until it gives up.
    expect((await rescheduleJob())?.state).toBe("done");
  });

  it("refuses a campaign with nobody on it rather than asking nobody", async () => {
    await db(env)
      .delete(schema.campaignMembers)
      .where(eq(schema.campaignMembers.campaignId, "age-of-umbra"));

    expect(await openRescheduleFor(env, SESSION_ID, { now: new Date() })).toMatchObject({
      ok: false,
      reason: "nobody",
    });
  });
});

describe("a reschedule somebody types", () => {
  it("gets the same whole-roster bar as one a veto opened", async () => {
    await roster("gm-1", ["p-1"]);

    const { openPoll } = await import("../src/polls/open.ts");
    const opened = await openPoll(env, {
      actor: actor("gm-1"),
      targetSessionId: SESSION_ID,
      channelId: "chan-1",
      dates: [{ startsAt: STARTS_AT + 86_400, endsAt: STARTS_AT + 90_000, source: "typed" }],
      now: new Date(),
    });

    expect(opened.ok).toBe(true);
    // One rule, whichever way the poll was opened. A `/reschedule` that settled on
    // "whatever did best" would move a game onto a night the GM had not agreed to.
    expect((await polls())[0]).toMatchObject({
      winRule: "quorum_of_roster",
      winThreshold: 1,
      campaignId: "age-of-umbra",
    });
  });

  it("keeps best-available for a campaign with no roster entered", async () => {
    const { openPoll } = await import("../src/polls/open.ts");
    await openPoll(env, {
      actor: actor("gm-1"),
      targetSessionId: SESSION_ID,
      channelId: "chan-1",
      dates: [{ startsAt: STARTS_AT + 86_400, endsAt: STARTS_AT + 90_000, source: "typed" }],
      now: new Date(),
    });

    // All three real campaigns are in this state until #26's rosters are entered,
    // and a whole-roster bar over an empty roster is one no date can ever clear.
    expect((await polls())[0]).toMatchObject({ winRule: "best_available" });
  });
});
