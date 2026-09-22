import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db, schema } from "../src/db/index.ts";
import { SETTING_KEYS, setSetting } from "../src/db/settings.ts";
import { seedStatements } from "../src/db/seed-sql.ts";
import { drainJobs } from "../src/jobs/drain.ts";
import { loadProjectionTarget } from "../src/projection/target.ts";
import { armReminders, sendReminder } from "../src/attendance/reminders.ts";

/**
 * Three nudges, and only to the people who have not answered. A reminder sent to
 * somebody who already said yes is the thing that teaches a server to mute a bot.
 */
const realFetch = globalThis.fetch;
const SESSION_ID = "age-of-umbra-s12";
const STARTS_AT = Date.parse("2026-09-20T19:00:00Z") / 1000;

let calls: { path: string; body: Record<string, unknown> }[] = [];
/** Discord id → whether their DMs are shut. */
let closedDms = new Set<string>();
let lastRecipient: string | undefined;

const campaign = {
  name: "Age of Umbra",
  kind: "run",
  discordChannelId: "chan-1",
  discordRoleId: "role-1",
} as const;

const session = { number: 12, startsAt: STARTS_AT, endsAt: STARTS_AT + 4 * 3600, location: "The Wreck" };

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
    .values({ campaignId: "age-of-umbra", userId: id });
  if (intent !== null) {
    await db(env)
      .insert(schema.attendance)
      .values({ sessionId: SESSION_ID, userId: id, intent });
  }
}

function dms() {
  return calls.filter((call) => call.path.startsWith("/channels/dm-"));
}

function threadPosts() {
  return calls.filter((call) => call.path === "/channels/thread-1/messages");
}

beforeEach(async () => {
  calls = [];
  closedDms = new Set();
  lastRecipient = undefined;

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    const path = url.pathname.replace("/api/v10", "");
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    calls.push({ path, body });

    if (path === "/users/@me/channels") {
      lastRecipient = String(body.recipient_id);
      return Response.json({ id: `dm-${lastRecipient}` });
    }
    if (path.startsWith("/channels/dm-")) {
      const who = path.slice("/channels/dm-".length).replace("/messages", "");
      if (closedDms.has(who)) {
        return Response.json({ code: 50007, message: "Cannot send messages" }, { status: 403 });
      }
      return Response.json({ id: "dm-msg", channel_id: `dm-${who}` });
    }
    return Response.json({ id: `msg-${calls.length}`, channel_id: "chan-1" });
  }) as typeof fetch;

  for (const table of ["publications", "attendance", "campaign_members", "jobs", "sessions", "campaigns", "users", "settings"]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  await setSetting(env, SETTING_KEYS.guildId, "g1");
  for (const statement of seedStatements(campaign, session)) {
    await env.DB.prepare(statement).run();
  }
  await env.DB.prepare("DELETE FROM jobs").run();
  await env.DB.prepare("UPDATE sessions SET thread_id = 'thread-1'").run();
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("arming the ladder", () => {
  it("puts one job at each step", async () => {
    await armReminders(env, SESSION_ID, STARTS_AT);

    const rows = await db(env).select().from(schema.jobs).all();
    expect(rows.map((row) => row.runAt).sort((a, b) => a - b)).toEqual(
      [72, 24, 2].map((h) => STARTS_AT - h * 3600).sort((a, b) => a - b),
    );
  });

  it("takes the steps from settings", async () => {
    await setSetting(env, SETTING_KEYS.reminderStepsHours, [12]);
    await armReminders(env, SESSION_ID, STARTS_AT);

    const rows = await db(env).select().from(schema.jobs).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.runAt).toBe(STARTS_AT - 12 * 3600);
  });

  it("moves the whole ladder with the session", async () => {
    await armReminders(env, SESSION_ID, STARTS_AT);
    const moved = STARTS_AT + 7 * 86_400;

    await armReminders(env, SESSION_ID, moved);

    const rows = await db(env).select().from(schema.jobs).all();
    // A nudge at the old T-24h is a nudge on the wrong day.
    expect(rows).toHaveLength(3);
    expect(rows.every((row) => row.runAt > STARTS_AT)).toBe(true);
  });
});

describe("sending one", () => {
  it("nudges only the people who have not answered", async () => {
    await member("said-in", "in");
    await member("said-out", "out");
    await member("said-maybe", "maybe");
    await member("silent", null);

    const outcome = await sendReminder(env, await target(), 24);

    // `in` and `out` are answers. Null and maybe are not.
    expect(outcome.dmed.sort()).toEqual(["said-maybe", "silent"]);
    expect(dms()).toHaveLength(2);
  });

  it("falls back to one shared message for everybody it could not DM", async () => {
    await member("a", null);
    await member("b", null);
    await member("c", null);
    closedDms.add("a");
    closedDms.add("b");

    const outcome = await sendReminder(env, await target(), 24);

    expect(outcome).toMatchObject({ dmed: ["c"], mentioned: ["a", "b"] });
    // One message, not one each: the thread is shared, so three separate
    // mentions of three people is three notifications for all of them.
    expect(threadPosts()).toHaveLength(1);
    expect(threadPosts()[0]?.body.content).toContain("<@a>");
    expect(threadPosts()[0]?.body.content).toContain("<@b>");
    expect(threadPosts()[0]?.body.allowed_mentions).toMatchObject({ parse: [], users: ["a", "b"] });
  });

  it("remembers a shut DM and does not try it again at the next step", async () => {
    await member("a", null);
    closedDms.add("a");

    await sendReminder(env, await target(), 72);
    calls = [];

    await sendReminder(env, await target(), 24);

    expect(dms()).toEqual([]);
    expect(calls.filter((call) => call.path === "/users/@me/channels")).toEqual([]);
    expect(threadPosts()).toHaveLength(1);
  });

  it("lets one person's failure not stop the others being asked", async () => {
    await member("a", null);
    await member("b", null);
    closedDms.add("a");

    const outcome = await sendReminder(env, await target(), 24);

    expect(outcome.dmed).toEqual(["b"]);
    expect(outcome.mentioned).toEqual(["a"]);
  });

  it("says nothing when everybody has answered", async () => {
    await member("a", "in");
    await member("b", "out");

    expect(await sendReminder(env, await target(), 24)).toMatchObject({ dmed: [], mentioned: [] });
    expect(calls).toEqual([]);
  });

  it("says nothing about a session that is off", async () => {
    await member("a", null);
    await env.DB.prepare("UPDATE sessions SET state = 'CANCELLED'").run();

    await sendReminder(env, await target(), 24);

    expect(calls).toEqual([]);
  });

  it("posts each step's fallback as its own message", async () => {
    await member("a", null);
    closedDms.add("a");

    await sendReminder(env, await target(), 72);
    await sendReminder(env, await target(), 24);

    // Three nudges are three messages. Nothing edits anything, here or anywhere.
    expect(threadPosts()).toHaveLength(2);
  });
});

describe("the drain", () => {
  it("sends the rung whose time has come", async () => {
    await member("a", null);
    await armReminders(env, SESSION_ID, Math.floor(Date.now() / 1000) + 3600);

    await drainJobs(env);

    // Only the steps already due: at T+1h, the 72h and 24h rungs are past and
    // the 2h one is not.
    expect(dms().length).toBeGreaterThan(0);
  });
});

describe("a rung that has to be retried", () => {
  /** The thread post is the only thing here that can throw, and the drain retries it. */
  function refuseThread() {
    const inner = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      );
      if (url.pathname.endsWith("/channels/thread-1/messages")) {
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        calls.push({ path: "/channels/thread-1/messages", body });
        return Response.json({ code: 50001, message: "Missing Access" }, { status: 403 });
      }
      return inner(input, init);
    }) as typeof fetch;
  }

  it("does not DM anybody a second time", async () => {
    await member("a", null);
    await member("b", null);
    await member("c", null);
    closedDms.add("c");
    refuseThread();

    await expect(sendReminder(env, await target(), 72)).rejects.toThrow();
    expect(dms()).toHaveLength(3);
    calls = [];

    // The drain answers a throw by running the whole thing again from the top.
    // Without a record of who has already been asked, everybody gets it twice —
    // and on a 4xx the thread claim is released, so this repeats every minute
    // until the session is played.
    await expect(sendReminder(env, await target(), 72)).rejects.toThrow();
    expect(dms()).toEqual([]);
  });

  it("still names the unreachable people in the thread on the retry", async () => {
    await member("a", null);
    await member("c", null);
    closedDms.add("c");
    refuseThread();
    await expect(sendReminder(env, await target(), 72)).rejects.toThrow();
    calls = [];

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      );
      calls.push({
        path: url.pathname.replace("/api/v10", ""),
        body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
      });
      return Response.json({ id: "msg-1", channel_id: "chan-1" });
    }) as typeof fetch;

    const outcome = await sendReminder(env, await target(), 72);

    // Their outcome was recorded, so the retry knows who was reachable without
    // asking Discord again.
    expect(outcome).toMatchObject({ dmed: ["a"], mentioned: ["c"] });
    expect(threadPosts()).toHaveLength(1);
    expect(String(threadPosts()[0]?.body.content)).toContain("<@c>");
  });

  it("keeps each rung's record separate, so the next step still asks", async () => {
    await member("a", null);

    await sendReminder(env, await target(), 72);
    expect(dms()).toHaveLength(1);
    calls = [];

    await sendReminder(env, await target(), 24);

    // Three nudges is three nudges. The record is per rung, not per session.
    expect(dms()).toHaveLength(1);
  });
});

/**
 * What the nudge asks for, which is not the same thing under the two rules (#173).
 */
describe("what the nudge says", () => {
  it("tells a table on the veto rule to answer only if something is wrong", async () => {
    await member("silent", null);

    await sendReminder(env, await target(), 24);

    // Telling somebody they "have not said" when the rule already took their
    // silence as yes is asking them to do something with no effect — and it is the
    // sentence most likely to make a table start answering a post it never had to.
    const content = String(dms()[0]?.body.content ?? "");
    expect(content).toContain("down as **in**");
    expect(content).toContain("Press **Out** only if you cannot make it");
    expect(content).not.toContain("have not said");
  });

  it("asks a campaign that counts for an answer, as it always did", async () => {
    await db(env)
      .update(schema.campaigns)
      .set({ quorum: 3 })
      .where(eq(schema.campaigns.id, "age-of-umbra"));
    await member("silent", null);

    await sendReminder(env, await target(), 24);

    // A tally cannot clear a bar without an answer, so somebody who has said
    // nothing is a gap in it.
    expect(String(dms()[0]?.body.content ?? "")).toContain(
      "have not said whether you are coming",
    );
  });

  it("says the same thing in the thread when a DM is shut", async () => {
    await member("a", null);
    closedDms.add("a");

    await sendReminder(env, await target(), 24);

    expect(String(threadPosts()[0]?.body.content ?? "")).toContain("down as in");
  });
});
