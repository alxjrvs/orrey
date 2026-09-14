import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db, schema } from "../src/db/index.ts";
import { SETTING_KEYS, setSetting } from "../src/db/settings.ts";
import { seedStatements } from "../src/db/seed-sql.ts";
import { scheduledEventBody, EntityType } from "../src/discord/events.ts";
import { loadProjectionTarget } from "../src/projection/target.ts";
import { project } from "../src/queue/consumer.ts";
import { claim, find, record } from "../src/projection/publications.ts";

/**
 * Discord itself, scripted. Every call the projector makes lands here, so the
 * assertions are about what Orrey would actually send.
 */
interface Call {
  method: string;
  path: string;
  body: Record<string, unknown> | undefined;
}

const realFetch = globalThis.fetch;
/** A guild of its own per test: the governor is a Durable Object, and a hold
 *  taken by the rate-limit test would otherwise make the next one wait. */
let guildId = "g0";
let guilds = 0;
let calls: Call[] = [];
let replies: { status: number; body: unknown; headers?: Record<string, string> }[] = [];
/**
 * What the guild already holds when Orrey looks before creating. Answered out of
 * band rather than from `replies`, because the scan happens on every create and
 * scripting it into every case would say nothing about any of them.
 */
let existingEvents: { id: string; name: string; status: number; description?: string }[] = [];

function reply(status: number, body: unknown, headers?: Record<string, string>) {
  replies.push({ status, body, ...(headers ? { headers } : {}) });
}

beforeEach(async () => {
  calls = [];
  replies = [];
  existingEvents = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    calls.push({
      method: init?.method ?? "GET",
      path: url.pathname.replace("/api/v10", ""),
      body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined,
    });
    const listing =
      (init?.method ?? "GET") === "GET" && url.pathname.endsWith("/scheduled-events");
    const next = listing
      ? { status: 200, body: existingEvents }
      : (replies.shift() ?? { status: 200, body: { id: "evt-new", name: "", status: 1 } });
    return new Response(next.status === 204 ? null : JSON.stringify(next.body), {
      status: next.status,
      headers: { "content-type": "application/json", ...next.headers },
    });
  }) as typeof fetch;

  // The ledger outlives the session row on purpose (#73), so it outlives the
  // test's cleanup too unless the test says otherwise.
  await env.DB.prepare("DELETE FROM publications").run();
  await env.DB.prepare("DELETE FROM sessions").run();
  await env.DB.prepare("DELETE FROM campaigns").run();
  await env.DB.prepare("DELETE FROM settings").run();
  guildId = `g${++guilds}`;
  await setSetting(env, SETTING_KEYS.guildId, guildId);
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

const campaign = {
  name: "Age of Umbra",
  kind: "run",
  discordChannelId: "100",
  discordRoleId: "200",
} as const;

const session = {
  number: 12,
  startsAt: Date.parse("2026-09-20T19:00:00Z") / 1000,
  endsAt: Date.parse("2026-09-20T23:00:00Z") / 1000,
  location: "The Wreck",
};

const SESSION_ID = "age-of-umbra-s12";

async function seed(over: Partial<typeof session> = {}): Promise<void> {
  for (const statement of seedStatements(campaign, { ...session, ...over })) {
    await env.DB.prepare(statement).run();
  }
}

function upsert() {
  return project({ kind: "discord.event.upsert", sessionId: SESSION_ID }, env);
}

async function storedSession() {
  return db(env).select().from(schema.sessions).get();
}

describe("the event body", () => {
  it("is EXTERNAL with a place and an end time when the campaign plays somewhere", async () => {
    await seed();
    const body = scheduledEventBody((await loadProjectionTarget(env, SESSION_ID))!);

    expect(body).toMatchObject({
      name: "Age of Umbra — Session 12",
      entity_type: EntityType.EXTERNAL,
      channel_id: null,
      entity_metadata: { location: "The Wreck" },
      scheduled_start_time: "2026-09-20T19:00:00.000Z",
      scheduled_end_time: "2026-09-20T23:00:00.000Z",
    });
  });

  it("is VOICE with a channel when the campaign plays in one", async () => {
    await seed();
    await env.DB.prepare(
      "UPDATE campaigns SET location_type = 'voice', discord_voice_channel_id = '900'",
    ).run();

    const body = scheduledEventBody((await loadProjectionTarget(env, SESSION_ID))!);
    expect(body).toMatchObject({ entity_type: EntityType.VOICE, channel_id: "900" });
    // Explicitly null, not absent: converting an existing EXTERNAL event to
    // VOICE is a PATCH, and Discord rejects one still carrying a location.
    expect(body.entity_metadata).toBeNull();
  });
});

describe("projecting a session to Discord", () => {
  it("creates the event and stores its id and fingerprint", async () => {
    await seed();
    reply(200, { id: "evt-1", name: "Age of Umbra — Session 12", status: 1 });

    await upsert();

    // Look, then create — never create blind. The scan is what makes a crash
    // between the POST and the write that remembers it survivable (#73).
    expect(calls).toMatchObject([
      { method: "GET", path: `/guilds/${guildId}/scheduled-events` },
      { method: "POST", path: `/guilds/${guildId}/scheduled-events` },
    ]);
    expect(calls[1]?.body).toMatchObject({ description: `[orrey:session:${SESSION_ID}]` });

    const stored = await storedSession();
    expect(stored?.discordEventId).toBe("evt-1");
    expect(stored?.discordEventFingerprint).toMatch(/^[0-9a-f]{32}$/);
  });

  it("is idempotent: redelivering the same message writes nothing", async () => {
    await seed();
    reply(200, { id: "evt-1", name: "", status: 1 });
    await upsert();
    calls = [];

    await upsert();
    await upsert();

    expect(calls).toEqual([]);
  });

  it("modifies the event it already made when the session moves", async () => {
    await seed();
    reply(200, { id: "evt-1", name: "", status: 1 });
    await upsert();
    calls = [];

    await seed({ startsAt: session.startsAt + 86_400, endsAt: session.endsAt + 86_400 });
    reply(200, { id: "evt-1", name: "", status: 1 });
    await upsert();

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      method: "PATCH",
      path: `/guilds/${guildId}/scheduled-events/evt-1`,
    });
    expect(calls[0]?.body).toMatchObject({ scheduled_start_time: "2026-09-21T19:00:00.000Z" });
  });

  it("mints a new event when the stored one has gone — the id is not forever", async () => {
    await seed();
    reply(200, { id: "evt-1", name: "", status: 1 });
    await upsert();
    calls = [];

    await seed({ location: "Somewhere else" });
    reply(404, { code: 10070, message: "Unknown Guild Scheduled Event" });
    reply(200, { id: "evt-2", name: "", status: 1 });
    await upsert();

    expect(calls.map((c) => c.method)).toEqual(["PATCH", "POST"]);
    expect((await storedSession())?.discordEventId).toBe("evt-2");
  });

  it("converts between EXTERNAL and VOICE by clearing the other type's field", async () => {
    await seed();
    const external = scheduledEventBody((await loadProjectionTarget(env, SESSION_ID))!);
    expect(external.channel_id).toBeNull();
    expect(external.entity_metadata).toEqual({ location: "The Wreck" });

    await env.DB.prepare(
      "UPDATE campaigns SET location_type = 'voice', discord_voice_channel_id = '900'",
    ).run();
    const voice = scheduledEventBody((await loadProjectionTarget(env, SESSION_ID))!);
    expect(voice.entity_metadata).toBeNull();
    expect(voice.channel_id).toBe("900");
  });

  it("holds the whole guild on a 429 and lets the queue retry", async () => {
    await seed();
    reply(429, { retry_after: 2.5, message: "You are being rate limited." });

    await expect(upsert()).rejects.toThrow(/429/);

    const governor = env.GUILD.get(env.GUILD.idFromName(guildId));
    expect(await governor.heldUntil()).toBeGreaterThan(Date.now() + 2000);
    // Nothing was recorded, so the retry will try the same write again.
    expect((await storedSession())?.discordEventId).toBeNull();
  });

  it("deletes the event and forgets it", async () => {
    await seed();
    reply(200, { id: "evt-1", name: "", status: 1 });
    await upsert();
    calls = [];

    reply(204, {});
    await project({ kind: "discord.event.delete", sessionId: SESSION_ID }, env);

    expect(calls[0]).toMatchObject({
      method: "DELETE",
      path: `/guilds/${guildId}/scheduled-events/evt-1`,
    });
    const stored = await storedSession();
    expect(stored?.discordEventId).toBeNull();
    expect(stored?.discordEventFingerprint).toBeNull();
  });

  it("treats an already-deleted event as deleted", async () => {
    await seed();
    reply(200, { id: "evt-1", name: "", status: 1 });
    await upsert();

    reply(404, { code: 10070, message: "Unknown Guild Scheduled Event" });
    await expect(
      project({ kind: "discord.event.delete", sessionId: SESSION_ID }, env),
    ).resolves.toBeUndefined();
    expect((await storedSession())?.discordEventId).toBeNull();
  });

  it("says plainly when cutover has not seeded the guild id", async () => {
    await seed();
    await env.DB.prepare("DELETE FROM settings").run();

    await expect(upsert()).rejects.toThrow(/discord.guild_id/);
    expect(calls).toEqual([]);
  });
});

/**
 * #73's other two findings. Discord hands out its own ids, so an event Orrey
 * made can outlive every record of it: the POST returns, the write that was
 * going to remember the id fails, and the retry creates a second one. And a
 * retraction used to need the session row at exactly the moment the row was
 * being deleted.
 */
const eventRef = { surface: "discord", kind: "event", targetId: SESSION_ID } as const;

function retractEvent() {
  return project({ kind: "discord.event.delete", sessionId: SESSION_ID }, env);
}

describe("not losing what was published", () => {
  it("adopts the event it already made rather than making a second one", async () => {
    await seed();
    // The crash window: the event is up and carries this session's marker, and
    // neither `sessions` nor the ledger ever learned its id.
    existingEvents = [
      { id: "evt-orphan", name: "Age of Umbra — Session 12", status: 1,
        description: `[orrey:session:${SESSION_ID}]` },
    ];
    reply(200, { id: "evt-orphan", name: "", status: 1 });

    await upsert();

    expect(calls.map((c) => c.method)).toEqual(["GET", "PATCH"]);
    expect(calls[1]?.path).toBe(`/guilds/${guildId}/scheduled-events/evt-orphan`);
    expect((await storedSession())?.discordEventId).toBe("evt-orphan");
  });

  it("does not adopt an event belonging to another session", async () => {
    await seed();
    existingEvents = [
      { id: "evt-someone-else", name: "Other", status: 1,
        description: "[orrey:session:some-other-session]" },
    ];
    reply(200, { id: "evt-1", name: "", status: 1 });

    await upsert();

    expect(calls.map((c) => c.method)).toEqual(["GET", "POST"]);
    expect((await storedSession())?.discordEventId).toBe("evt-1");
  });

  it("does not adopt an event whose session id merely starts the same way", async () => {
    await seed();
    // Session ids are `<campaign>-s<number>`, so `age-of-umbra-s1` is a prefix
    // of `age-of-umbra-s12`. An unterminated marker would let this session adopt
    // the other one's live event, rewrite it with the wrong times, and then
    // delete it on the next retraction.
    existingEvents = [
      { id: "evt-s12", name: "Age of Umbra — Session 12", status: 1,
        description: "[orrey:session:age-of-umbra-s120]" },
    ];
    reply(200, { id: "evt-fresh", name: "", status: 1 });

    await upsert();

    expect(calls.map((c) => c.method)).toEqual(["GET", "POST"]);
    expect((await storedSession())?.discordEventId).toBe("evt-fresh");
  });

  it("takes the id from the ledger without asking Discord at all", async () => {
    await seed();
    // Recorded in the ledger, never written to `sessions` — the window `p2/1`
    // narrowed. There is nothing to look for, so nothing is looked for.
    await claim(env, eventRef);
    await record(env, eventRef, "evt-led");
    reply(200, { id: "evt-led", name: "", status: 1 });

    await upsert();

    expect(calls.map((c) => c.method)).toEqual(["PATCH"]);
    expect(calls[0]?.path).toBe(`/guilds/${guildId}/scheduled-events/evt-led`);
  });

  it("does not adopt a retracted event back", async () => {
    await seed();
    await claim(env, eventRef);
    await record(env, eventRef, "evt-gone");
    await retractEvent();
    calls = [];
    reply(200, { id: "evt-new", name: "", status: 1 });

    await upsert();

    // It was taken down on purpose. Making it again would be the opposite of
    // what the retraction meant.
    expect(calls.map((c) => c.method)).toEqual(["GET", "POST"]);
  });

  it("rewrites an event that predates the marker, exactly once", async () => {
    await seed();
    // A live event from before this landed: an id, and a fingerprint taken when
    // the body had no marker in it.
    await env.DB.prepare(
      "UPDATE sessions SET discord_event_id = ?, discord_event_fingerprint = ? WHERE id = ?",
    )
      .bind("evt-pre-marker", "a-fingerprint-from-before", SESSION_ID)
      .run();
    reply(200, { id: "evt-pre-marker", name: "", status: 1 });

    await upsert();

    expect(calls.map((c) => c.method)).toEqual(["PATCH"]);
    expect(calls[0]?.body).toMatchObject({ description: `[orrey:session:${SESSION_ID}]` });

    // And then it is stable: the marker is constant, so this is one PATCH per
    // live event and never a rewrite loop.
    calls = [];
    await upsert();
    expect(calls).toEqual([]);
  });

  it("retracts an event whose session row is already gone", async () => {
    await seed();
    reply(200, { id: "evt-1", name: "", status: 1 });
    await upsert();

    // Deleting is exactly when the row disappears, so this is the common path.
    await env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(SESSION_ID).run();
    calls = [];
    reply(204, null);

    await retractEvent();

    expect(calls).toMatchObject([
      { method: "DELETE", path: `/guilds/${guildId}/scheduled-events/evt-1` },
    ]);
    expect(await find(env, eventRef)).toMatchObject({ state: "retracted", remoteId: "evt-1" });
  });

  it("has nothing to retract when nothing was ever published", async () => {
    await seed();
    await env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(SESSION_ID).run();

    await retractEvent();

    // No ledger row, so no DELETE for an event Orrey never made.
    expect(calls).toEqual([]);
  });
});
