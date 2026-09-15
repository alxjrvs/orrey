import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db, schema } from "../src/db/index.ts";
import { SETTING_KEYS, setSetting } from "../src/db/settings.ts";
import type { Env, OutboxMessage } from "../src/env.ts";
import { fingerprint } from "../src/projection/fingerprint.ts";
import { googleFingerprint, loadProjectionTarget } from "../src/projection/target.ts";
import { applyChange } from "../src/google/inbound.ts";
import { classifyAll } from "../src/google/sync.ts";
import { shapeOf } from "../src/google/classify.ts";
import type { CalendarEvent } from "../src/google/sync.ts";

/**
 * A GM dragged it.
 *
 * The two tests that matter here are the ones that say **the loop terminates**.
 * Everything else in the return path is plumbing; this is where a mistake means
 * Orrey and a human take turns rewriting the same event until somebody notices.
 */
const realFetch = globalThis.fetch;
const START = Math.floor(Date.parse("2026-09-20T19:00:00Z") / 1000);
const SESSION_ID = "umbra-s12";

let calls: { method: string; path: string; body: Record<string, unknown> }[] = [];
let sent: OutboxMessage[] = [];

function outboxEnv(): Env {
  return {
    ...env,
    OUTBOX: {
      send: async (body: OutboxMessage) => void sent.push(body),
      sendBatch: async (batch: Iterable<{ body: OutboxMessage }>) => {
        for (const { body } of batch) sent.push(body);
      },
    } as unknown as Env["OUTBOX"],
  } as Env;
}

function event(over: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id: "evt-1",
    status: "confirmed",
    summary: "Age of Umbra — Session 12",
    location: "The Wreck",
    start: { dateTime: new Date(START * 1000).toISOString() },
    end: { dateTime: new Date((START + 4 * 3600) * 1000).toISOString() },
    extendedProperties: { private: { orreySessionId: SESSION_ID } },
    ...over,
  };
}

function sessionRow() {
  return db(env).select().from(schema.sessions).where(eq(schema.sessions.id, SESSION_ID)).get();
}

function linkRow() {
  return db(env)
    .select()
    .from(schema.calendarLinks)
    .where(eq(schema.calendarLinks.sessionId, SESSION_ID))
    .get();
}

/** The fingerprint the projector would have stored for the untouched event. */
async function storedFingerprint(): Promise<string> {
  const target = (await loadProjectionTarget(env, SESSION_ID))!;
  return googleFingerprint(target);
}

async function seed() {
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
    .insert(schema.sessions)
    .values({
      id: SESSION_ID,
      kind: "campaign_session",
      campaignId: "umbra",
      number: 12,
      startsAt: START,
      endsAt: START + 4 * 3600,
      location: "The Wreck",
      state: "SCHEDULED",
      threadId: "thread-1",
    });
  await db(env)
    .insert(schema.calendarLinks)
    .values({
      sessionId: SESSION_ID,
      gcalEventId: "evt-1",
      fingerprint: await storedFingerprint(),
    });
}

beforeEach(async () => {
  calls = [];
  sent = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    calls.push({
      method: init?.method ?? "GET",
      path: url.pathname.replace("/api/v10", ""),
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
    });
    return Response.json({ id: `msg-${calls.length}`, channel_id: "chan-1" });
  }) as typeof fetch;

  for (const table of [
    "audit_log",
    "publications",
    "calendar_links",
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
  await seed();
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("the times moved", () => {
  it("moves the row", async () => {
    const moved = event({
      start: { dateTime: new Date((START + 86_400) * 1000).toISOString() },
      end: { dateTime: new Date((START + 86_400 + 4 * 3600) * 1000).toISOString() },
    });

    expect(await applyChange(outboxEnv(), SESSION_ID, moved)).toBe("moved");
    expect(await sessionRow()).toMatchObject({
      startsAt: START + 86_400,
      endsAt: START + 86_400 + 4 * 3600,
    });
  });

  it("takes a retyped venue in the same drag", async () => {
    const moved = event({
      start: { dateTime: new Date((START + 3600) * 1000).toISOString() },
      location: "Ada's front room",
    });

    await applyChange(outboxEnv(), SESSION_ID, moved);

    expect(await sessionRow()).toMatchObject({ location: "Ada's front room" });
  });

  it("posts one notice into the thread, and edits nothing", async () => {
    await applyChange(
      outboxEnv(),
      SESSION_ID,
      event({ start: { dateTime: new Date((START + 3600) * 1000).toISOString() } }),
    );

    const posts = calls.filter((call) => call.path === "/channels/thread-1/messages");
    expect(posts).toHaveLength(1);
    expect(posts[0]?.method).toBe("POST");
    // There is no interaction here, so `UPDATE_MESSAGE` is not even in reach —
    // an edit would be the send-only invariant broken outright.
    expect(calls.filter((call) => call.method === "PATCH")).toEqual([]);
  });

  it("re-projects, and re-arms every job the old date was pointing at", async () => {
    await applyChange(
      outboxEnv(),
      SESSION_ID,
      event({ start: { dateTime: new Date((START + 3600) * 1000).toISOString() } }),
    );

    // `moveSession` arms `session.project` rather than enqueueing directly, so
    // the projection is inspectable and re-runnable like every other piece of
    // time-shifted work here. The drain's own case is what reaches the queue.
    const kinds = (await db(env).select().from(schema.jobs).all()).map((job) => job.kind);
    expect(kinds).toContain("session.project");
    // The check, the nudges and the register were all pointing at the old day.
    expect(kinds).toContain("jeopardy.check");
    expect(kinds).toContain("attendance.assume");
  });

  it("posts one notice for two pushes about the same change", async () => {
    const moved = event({ start: { dateTime: new Date((START + 3600) * 1000).toISOString() } });

    await applyChange(outboxEnv(), SESSION_ID, moved);
    const after = calls.filter((call) => call.path === "/channels/thread-1/messages").length;
    await applyChange(outboxEnv(), SESSION_ID, moved);

    // The second is a no-op: the row already says what the event says, so
    // `moveSession` returns before writing. The notice is claimed under a label
    // as well, so even a genuine re-run posts once.
    expect(calls.filter((call) => call.path === "/channels/thread-1/messages")).toHaveLength(after);
  });

  it("never takes the state from Google", async () => {
    await applyChange(
      outboxEnv(),
      SESSION_ID,
      event({
        summary: "CANCELLED — not happening",
        start: { dateTime: new Date((START + 3600) * 1000).toISOString() },
      }),
    );

    // #48 is explicit: Google never cancels a session.
    expect(await sessionRow()).toMatchObject({ state: "SCHEDULED" });
  });
});

describe("the loop terminates", () => {
  it("classifies the projector's own rewrite as an echo", async () => {
    const moved = event({
      start: { dateTime: new Date((START + 86_400) * 1000).toISOString() },
      end: { dateTime: new Date((START + 86_400 + 4 * 3600) * 1000).toISOString() },
    });
    await applyChange(outboxEnv(), SESSION_ID, moved);

    // Stand in for the projector: it writes the event from the new row and
    // records the fingerprint it computed.
    const after = (await loadProjectionTarget(env, SESSION_ID))!;
    await db(env)
      .update(schema.calendarLinks)
      .set({ fingerprint: await googleFingerprint(after) })
      .where(eq(schema.calendarLinks.sessionId, SESSION_ID));

    // Google pushes about that write. Feed the resulting event back through.
    const rewritten = event({
      summary: "Age of Umbra — Session 12",
      start: { dateTime: new Date((START + 86_400) * 1000).toISOString() },
      end: { dateTime: new Date((START + 86_400 + 4 * 3600) * 1000).toISOString() },
    });
    const [verdict] = await classifyAll(env, [rewritten]);

    expect(verdict?.verdict).toBe("echo");
  });

  it("stops there — an echo writes nothing and posts nothing", async () => {
    const before = await sessionRow();
    sent = [];
    calls = [];

    const [verdict] = await classifyAll(env, [event()]);

    expect(verdict?.verdict).toBe("echo");
    expect(await sessionRow()).toEqual(before);
    expect(sent).toEqual([]);
    expect(calls).toEqual([]);
  });
});

describe("nothing Orrey adopts moved", () => {
  const retyped = () => event({ summary: "Umbra — at Ada's this week!!" });

  it("writes nothing to the session", async () => {
    const before = await sessionRow();

    expect(await applyChange(outboxEnv(), SESSION_ID, retyped())).toBe("re-projected");

    // The title is derived from the campaign and the session number. Adopting a
    // retyped one would start a fight the projector wins on the next write.
    expect(await sessionRow()).toEqual(before);
  });

  it("posts no notice", async () => {
    await applyChange(outboxEnv(), SESSION_ID, retyped());

    expect(calls).toEqual([]);
  });

  it("clears the fingerprint, so the next projection cannot be skipped", async () => {
    // Without this the row is unchanged, the stored fingerprint still matches,
    // `upsert` skips the write, Google keeps the retyped summary, and every
    // pass classifies it `changed` again — forever.
    expect((await linkRow())?.fingerprint).toEqual(expect.any(String));

    await applyChange(outboxEnv(), SESSION_ID, retyped());

    expect((await linkRow())?.fingerprint).toBeNull();
    expect(sent).toEqual([{ kind: "gcal.upsert", sessionId: SESSION_ID }]);
  });

  it("and the projection that follows is recognised as an echo", async () => {
    await applyChange(outboxEnv(), SESSION_ID, retyped());

    // The projector writes Orrey's title back and records the fingerprint.
    const target = (await loadProjectionTarget(env, SESSION_ID))!;
    await db(env)
      .update(schema.calendarLinks)
      .set({ fingerprint: await googleFingerprint(target) })
      .where(eq(schema.calendarLinks.sessionId, SESSION_ID));

    const [verdict] = await classifyAll(env, [event()]);

    expect(verdict?.verdict).toBe("echo");
  });
});

describe("the shape the two halves share", () => {
  it("is the same one the projector hashes", async () => {
    const target = (await loadProjectionTarget(env, SESSION_ID))!;
    const session = (await sessionRow())!;

    // If these two ever disagreed, no event would match and every pass would
    // call everything changed. This is the same assertion the classifier makes,
    // repeated here because this file is where it would bite.
    expect(await fingerprint(shapeOf(event(), session))).toBe(await googleFingerprint(target));
  });
});
