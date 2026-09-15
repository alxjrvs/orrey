import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db, schema } from "../src/db/index.ts";
import { SETTING_KEYS, setSetting } from "../src/db/settings.ts";
import { mintId } from "../src/db/ids.ts";
import { SESSION_MOVED } from "../src/db/audit.ts";
import { createApp } from "../src/http/app.ts";
import { InteractionType } from "../src/discord/types.ts";
import { encodeCustomId } from "../src/discord/custom-id.ts";
import { fakeDiscord } from "./discord.ts";
import { isLapsedEvent } from "../src/discord/rest.ts";
import { drainJobs } from "../src/jobs/drain.ts";

/**
 * The date moves, and the two projections that show it follow. The Discord event
 * is the half that cannot be moved in place, which is most of the interest here.
 */
const realFetch = globalThis.fetch;
const discord = await fakeDiscord();
const app = createApp();
const SESSION = "umbra-s12";
const POLL = "pollid123456";
const NOW = Math.floor(Date.now() / 1000);
const DAY = 86_400;

let calls: { method: string; path: string }[] = [];
let dates: { id: string; startsAt: number }[] = [];

async function seed({ startsAt }: { startsAt: number }) {
  await db(env)
    .insert(schema.campaigns)
    .values({
      id: "umbra",
      name: "Age of Umbra",
      kind: "run",
      state: "RUNNING",
      discordChannelId: "chan-1",
      discordRoleId: "role-1",
    });
  await db(env)
    .insert(schema.users)
    .values({ discordId: "opener", username: "opener", feedToken: "t-opener" });
  await db(env).insert(schema.sessions).values({
    id: SESSION,
    kind: "campaign_session",
    campaignId: "umbra",
    number: 12,
    startsAt,
    endsAt: startsAt + 4 * 3600,
    location: "The Wreck",
    threadId: "thread-1",
    discordEventId: "event-1",
    discordEventFingerprint: "fp-old",
  });
  await db(env)
    .insert(schema.datePolls)
    .values({
      id: POLL,
      targetSessionId: SESSION,
      campaignId: "umbra",
      discordChannelId: "chan-1",
      openedBy: "opener",
      winRule: "organiser_picks",
    });

  dates = [];
  for (const offset of [30, 37]) {
    const id = mintId();
    const at = NOW + offset * DAY;
    await db(env)
      .insert(schema.pollDates)
      .values({ id, pollId: POLL, startsAt: at, endsAt: at + 4 * 3600 });
    dates.push({ id, startsAt: at });
  }
}

function click(arg: string, values?: string[]) {
  return discord.request({
    type: InteractionType.MESSAGE_COMPONENT,
    data: {
      custom_id: encodeCustomId({ action: "poll", arg, target: POLL }),
      component_type: values ? 3 : 2,
      ...(values ? { values } : {}),
    },
    member: { user: { id: "opener", username: "opener", global_name: null }, roles: [] },
    guild_id: "g",
    message: { id: "msg-1", channel_id: "chan-1" },
  });
}

function sessionRow() {
  return db(env).select().from(schema.sessions).where(eq(schema.sessions.id, SESSION)).get();
}

function jobs() {
  return db(env)
    .select()
    .from(schema.jobs)
    .all()
    .then((rows) => rows.map((row) => row.kind).sort());
}

/**
 * Canonise, pick, Apply — and then the drain, because Apply no longer does the
 * move itself. It arms `poll.apply` in the same batch as the close, so that the
 * close and the move it owes are one fact rather than two a refused Discord call
 * can pull apart.
 */
async function canoniseWith(pollDateId: string) {
  await apply(pollDateId);
  await drainJobs(env);
}

async function apply(pollDateId: string) {
  await app.fetch(await click("canon"), discord.env(env));
  await app.fetch(await click("pick", [pollDateId]), discord.env(env));
  await app.fetch(await click("apply"), discord.env(env));
}

beforeEach(async () => {
  calls = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    calls.push({ method: init?.method ?? "GET", path: url.pathname.replace("/api/v10", "") });
    return Response.json({ id: `msg-${calls.length}`, channel_id: "chan-1" });
  }) as typeof fetch;

  for (const table of [
    "audit_log",
    "publications",
    "poll_responses",
    "poll_dates",
    "date_polls",
    "attendance",
    "jobs",
    "sessions",
    "campaigns",
    "users",
    "settings",
  ]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  await setSetting(env, SETTING_KEYS.guildId, "g1");
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("the move", () => {
  it("writes the new times and loses the old ones", async () => {
    await seed({ startsAt: NOW + 7 * DAY });

    await canoniseWith(dates[1]!.id);

    // Gone from D1, not shadowed by something newer: the database is the source
    // of truth and there is one answer in it.
    expect(await sessionRow()).toMatchObject({
      startsAt: dates[1]!.startsAt,
      endsAt: dates[1]!.startsAt + 4 * 3600,
    });
  });

  it("leaves the move on the record", async () => {
    await seed({ startsAt: NOW + 7 * DAY });

    await canoniseWith(dates[1]!.id);

    // The row the schedule statistics count. A trail with a hole in it for one
    // of the three ways a session moves is a number that undercounts without
    // ever looking wrong — and `actor_user_id` is null because the clock moved
    // this, not a person.
    const moves = (await db(env).select().from(schema.auditLog).all()).filter(
      (row) => row.action === SESSION_MOVED,
    );
    expect(moves).toHaveLength(1);
    expect(moves[0]).toMatchObject({ targetType: "session", actorUserId: null });
  });

  it("posts one notice in the thread and edits nothing", async () => {
    await seed({ startsAt: NOW + 7 * DAY });
    calls = [];

    await canoniseWith(dates[0]!.id);

    const posts = calls.filter((call) => call.path === "/channels/thread-1/messages");
    expect(posts).toHaveLength(1);
    expect(posts[0]?.method).toBe("POST");
    // Nothing in this path edits the attendance post or the poll post.
    expect(calls.filter((call) => call.method === "PATCH")).toEqual([]);
  });

  it("re-arms every job that was pointing at the old day", async () => {
    await seed({ startsAt: NOW + 7 * DAY });

    await canoniseWith(dates[0]!.id);

    expect(await jobs()).toEqual(
      [
        "attendance.assume",
        "jeopardy.check",
        "poll.apply",
        "reminder.step",
        "reminder.step",
        "reminder.step",
        "session.project",
        // The carry-over's fresh attendance post, added one slice up.
        "session.post-attendance",
      ].sort(),
    );
  });

  it("moves nothing when the poll settled on nothing", async () => {
    await seed({ startsAt: NOW + 7 * DAY });
    const before = await sessionRow();

    await app.fetch(await click("canon"), discord.env(env));
    await app.fetch(await click("pick", []), discord.env(env));
    await app.fetch(await click("apply"), discord.env(env));
    await drainJobs(env);

    expect(await sessionRow()).toMatchObject({ startsAt: before!.startsAt });
    // And nothing was even armed: there is no move owed.
    expect(await jobs()).toEqual([]);
  });
});

describe("the Discord event, which cannot be moved in place", () => {
  it("keeps the event id when the old date is still ahead", async () => {
    await seed({ startsAt: NOW + 7 * DAY });

    await canoniseWith(dates[0]!.id);

    // A future event can be PATCHed, so the id is worth keeping.
    expect(await sessionRow()).toMatchObject({ discordEventId: "event-1" });
  });

  it("drops the id — and the fingerprint with it — when the old date has passed", async () => {
    await seed({ startsAt: NOW - DAY });

    await canoniseWith(dates[0]!.id);

    // COMPLETED is terminal and fires on its own, so the old event cannot be
    // moved. Dropping the id makes `upsert` take its create branch — and the
    // fingerprint has to go too, or the next upsert compares the new content
    // against a stale hash, decides nothing changed, and skips the write.
    expect(await sessionRow()).toMatchObject({
      discordEventId: null,
      discordEventFingerprint: null,
    });
  });

  it("recognises a lapsed-event rejection by code, never by message text", () => {
    const lapsed = Object.assign(new Error("nope"), {
      name: "DiscordError",
      status: 400,
      code: 180_000,
    });
    const other = Object.assign(new Error("nope"), {
      name: "DiscordError",
      status: 400,
      code: 50_035,
    });

    expect(isLapsedEvent(lapsed)).toBe(true);
    expect(isLapsedEvent(other)).toBe(false);
    expect(isLapsedEvent(new Error("Cannot update a scheduled event"))).toBe(false);
  });
});

describe("what survives a refusal", () => {
  it("does not lose the move when Discord refuses the notice", async () => {
    await seed({ startsAt: NOW + 7 * DAY });

    // The thread post fails, once. Everything else answers normally.
    let failed = false;
    const inner = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      );
      if (!failed && url.pathname.includes("/channels/thread-1/messages")) {
        failed = true;
        return Response.json({ message: "boom" }, { status: 500 });
      }
      return inner(input as RequestInfo, init);
    }) as typeof fetch;

    await apply(dates[1]!.id);
    await drainJobs(env);

    // The date moved and every job was re-armed *before* the notice was
    // attempted, so the refusal cost the notice and nothing else. Before this
    // fix the order was the other way round: the post went first, and a refusal
    // left the session at its old date with nothing re-projected.
    expect(await sessionRow()).toMatchObject({ startsAt: dates[1]!.startsAt });
    expect(await jobs()).toContain("session.project");

    // And the job is not done, so the drain owns it until it lands.
    const job = await db(env)
      .select()
      .from(schema.jobs)
      .where(eq(schema.jobs.kind, "poll.apply"))
      .get();
    expect(job?.state).not.toBe("done");

    await db(env)
      .update(schema.jobs)
      .set({ state: "pending", attempts: 0 })
      .where(eq(schema.jobs.kind, "poll.apply"));
    await drainJobs(env);

    // The retry converges rather than looping: the claim `postNoticeOnce` took
    // stands, because a 5xx may have posted and a second "Moved." cannot be
    // taken back. The date is right either way, and the attendance post renders
    // it on the next click.
    expect(
      await db(env).select().from(schema.jobs).where(eq(schema.jobs.kind, "poll.apply")).get(),
    ).toMatchObject({ state: "done" });
  });

  it("posts one notice however many times the job runs", async () => {
    await seed({ startsAt: NOW + 7 * DAY });
    await canoniseWith(dates[0]!.id);
    calls = [];

    await db(env).update(schema.jobs).set({ state: "pending", attempts: 0 });
    await drainJobs(env);

    // The notice is claimed under its own label, so re-entering the move says
    // nothing a second time — and says nothing wrong either, because the date it
    // moved *from* rides in the payload rather than being read back.
    expect(calls.filter((call) => call.path === "/channels/thread-1/messages")).toEqual([]);
    expect(await sessionRow()).toMatchObject({ startsAt: dates[0]!.startsAt });
  });
});
