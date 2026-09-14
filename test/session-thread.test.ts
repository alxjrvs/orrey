import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db, schema } from "../src/db/index.ts";
import { SETTING_KEYS, setSetting } from "../src/db/settings.ts";
import { seedStatements } from "../src/db/seed-sql.ts";
import { drainJobs } from "../src/jobs/drain.ts";
import { loadProjectionTarget } from "../src/projection/target.ts";
import {
  postToSession,
  startSessionThread,
  threadName,
  threadPublication,
} from "../src/attendance/thread.ts";

/**
 * A thread per session. What is worth testing is where the later posts go and
 * what happens when Discord has made the thread but Orrey never learned its id.
 */
const realFetch = globalThis.fetch;
const SESSION_ID = "age-of-umbra-s12";

let calls: { method: string; path: string; body: Record<string, unknown> }[] = [];
let threadResponse: () => Response;

const campaign = {
  name: "Age of Umbra",
  kind: "run",
  discordChannelId: "chan-1",
  discordRoleId: "role-1",
} as const;

const session = {
  number: 12,
  startsAt: Date.parse("2026-09-20T19:00:00Z") / 1000,
  endsAt: Date.parse("2026-09-20T23:00:00Z") / 1000,
  location: "The Wreck",
};

async function target() {
  return (await loadProjectionTarget(env, SESSION_ID))!;
}

function sessionRow() {
  return db(env).select().from(schema.sessions).where(eq(schema.sessions.id, SESSION_ID)).get();
}

beforeEach(async () => {
  calls = [];
  threadResponse = () => Response.json({ id: "thread-1" });

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    const path = url.pathname.replace("/api/v10", "");
    calls.push({
      method: init?.method ?? "GET",
      path,
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
    });

    if (path.endsWith("/threads")) return threadResponse();
    return Response.json({ id: `msg-${calls.length}`, channel_id: "chan-1" });
  }) as typeof fetch;

  for (const table of ["publications", "attendance", "jobs", "sessions", "campaigns", "users", "settings"]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  await setSetting(env, SETTING_KEYS.guildId, "g1");
  for (const statement of seedStatements(campaign, session)) {
    await env.DB.prepare(statement).run();
  }
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("starting the thread", () => {
  it("hangs it off the attendance post and stores the id", async () => {
    await env.DB.prepare("UPDATE sessions SET discord_message_id = 'msg-1'").run();

    expect(await startSessionThread(env, await target())).toBe("thread-1");

    expect(calls).toMatchObject([
      { method: "POST", path: "/channels/chan-1/messages/msg-1/threads" },
    ]);
    expect(calls[0]?.body).toMatchObject({
      name: "Age of Umbra — Session 12 — 20 September",
      auto_archive_duration: 10_080,
    });
    expect((await sessionRow())?.threadId).toBe("thread-1");
  });

  it("makes no thread for a session that was never posted", async () => {
    expect(await startSessionThread(env, await target())).toBeUndefined();
    expect(calls).toEqual([]);
  });

  it("does nothing a second time", async () => {
    await env.DB.prepare("UPDATE sessions SET discord_message_id = 'msg-1'").run();
    await startSessionThread(env, await target());
    calls = [];

    expect(await startSessionThread(env, await target())).toBe("thread-1");
    expect(calls).toEqual([]);
  });

  it("heals from the ledger when only the session write was lost", async () => {
    await env.DB.prepare("UPDATE sessions SET discord_message_id = 'msg-1'").run();
    await startSessionThread(env, await target());
    // The thread is up and recorded; the session column is not.
    await env.DB.prepare("UPDATE sessions SET thread_id = NULL").run();
    calls = [];

    expect(await startSessionThread(env, await target())).toBe("thread-1");
    expect(calls).toEqual([]);
    expect((await sessionRow())?.threadId).toBe("thread-1");
  });

  it("stops asking once Discord says the message already has one", async () => {
    await env.DB.prepare("UPDATE sessions SET discord_message_id = 'msg-1'").run();
    threadResponse = () =>
      Response.json({ code: 160004, message: "A thread has already been created" }, { status: 400 });

    expect(await startSessionThread(env, await target())).toBeUndefined();

    // The thread exists and its id is unknowable from here. The claim stays,
    // because a second attempt cannot succeed either.
    expect(await threadPublication(env, SESSION_ID)).toMatchObject({
      state: "claimed",
      remoteId: null,
    });
  });

  it("names a thread Discord will accept", async () => {
    const long = { ...(await target()) };
    long.campaign = { ...long.campaign!, name: "A".repeat(200) };
    expect(threadName(long).length).toBeLessThanOrEqual(100);
  });
});

describe("where a later post goes", () => {
  it("into the thread, once there is one", async () => {
    await env.DB.prepare("UPDATE sessions SET discord_message_id = 'msg-1'").run();
    await startSessionThread(env, await target());
    calls = [];

    await postToSession(env, await target(), { content: "quorum reached" });

    expect(calls).toMatchObject([{ method: "POST", path: "/channels/thread-1/messages" }]);
  });

  it("into the campaign channel for a session that never got one", async () => {
    await postToSession(env, await target(), { content: "a notice" });
    expect(calls).toMatchObject([{ method: "POST", path: "/channels/chan-1/messages" }]);
  });
});

describe("the post job", () => {
  it("posts and then starts the thread, in that order", async () => {
    await drainJobs(env);

    expect(calls.map((call) => call.path)).toEqual([
      "/channels/chan-1/messages",
      "/channels/chan-1/messages/msg-1/threads",
    ]);
    expect(await sessionRow()).toMatchObject({
      discordMessageId: "msg-1",
      threadId: "thread-1",
    });
  });
});
