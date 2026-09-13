import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db, schema } from "../src/db/index.ts";
import { SETTING_KEYS, setSetting } from "../src/db/settings.ts";
import { seedStatements } from "../src/db/seed-sql.ts";
import { scheduledEventBody, EntityType } from "../src/discord/events.ts";
import { loadProjectionTarget } from "../src/projection/target.ts";
import { project } from "../src/queue/consumer.ts";

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

function reply(status: number, body: unknown, headers?: Record<string, string>) {
  replies.push({ status, body, ...(headers ? { headers } : {}) });
}

beforeEach(async () => {
  calls = [];
  replies = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    calls.push({
      method: init?.method ?? "GET",
      path: url.pathname.replace("/api/v10", ""),
      body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined,
    });
    const next = replies.shift() ?? { status: 200, body: { id: "evt-new", name: "", status: 1 } };
    return new Response(next.status === 204 ? null : JSON.stringify(next.body), {
      status: next.status,
      headers: { "content-type": "application/json", ...next.headers },
    });
  }) as typeof fetch;

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
    expect(body.entity_metadata).toBeUndefined();
  });
});

describe("projecting a session to Discord", () => {
  it("creates the event and stores its id and fingerprint", async () => {
    await seed();
    reply(200, { id: "evt-1", name: "Age of Umbra — Session 12", status: 1 });

    await upsert();

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: "POST", path: `/guilds/${guildId}/scheduled-events` });
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
