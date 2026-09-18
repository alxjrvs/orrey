import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db, schema } from "../src/db/index.ts";
import { SESSION_CONFIRMED } from "../src/db/audit.ts";
import { SETTING_KEYS, setSetting } from "../src/db/settings.ts";
import { seedStatements } from "../src/db/seed-sql.ts";
import { drainJobs } from "../src/jobs/drain.ts";
import { find } from "../src/projection/publications.ts";
import { loadProjectionTarget } from "../src/projection/target.ts";
import { postNoticeOnce } from "../src/attendance/notice.ts";
import { confirmedNotice } from "../src/attendance/render.ts";

/**
 * "Anything changing from outside posts a new notice rather than mutating an old
 * message." The hard part is not the posting — it is *once*.
 */
const realFetch = globalThis.fetch;
const SESSION_ID = "age-of-umbra-s12";

let calls: { path: string; body: Record<string, unknown> }[] = [];
let postResponse: () => Response;

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

const noticeRef = {
  surface: "discord",
  kind: "message",
  targetId: SESSION_ID,
  label: "confirmed",
} as const;

async function target() {
  return (await loadProjectionTarget(env, SESSION_ID))!;
}

function actor(id: string) {
  return { id, username: `p${id}`, global_name: null };
}

function lock() {
  return env.SESSION_LOCK.get(env.SESSION_LOCK.idFromName(SESSION_ID));
}

function jobs() {
  return db(env).select().from(schema.jobs).all();
}

beforeEach(async () => {
  calls = [];
  postResponse = () => Response.json({ id: `msg-${calls.length}`, channel_id: "chan-1" });

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    calls.push({
      path: url.pathname.replace("/api/v10", ""),
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
    });
    if (url.pathname.endsWith("/threads")) return Response.json({ id: "thread-1" });
    return postResponse();
  }) as typeof fetch;

  for (const table of ["audit_log", "publications", "attendance", "jobs", "sessions", "campaigns", "users", "settings"]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  await setSetting(env, SETTING_KEYS.guildId, "g1");
  for (const statement of seedStatements(campaign, session)) {
    await env.DB.prepare(statement).run();
  }
  await env.DB.prepare("DELETE FROM jobs").run();
  await db(env)
    .update(schema.campaigns)
    .set({ quorum: 2 })
    .where(eq(schema.campaigns.id, "age-of-umbra"));
  await env.DB.prepare("UPDATE sessions SET thread_id = 'thread-1'").run();
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("posting a notice once", () => {
  it("posts it into the thread", async () => {
    const id = await postNoticeOnce(env, await target(), "confirmed", confirmedNotice(await target()));

    expect(id).toBe("msg-1");
    expect(calls).toMatchObject([{ path: "/channels/thread-1/messages" }]);
    expect(calls[0]?.body).toMatchObject({ content: expect.stringContaining("It's on.") });
    expect(await find(env, noticeRef)).toMatchObject({ state: "published", remoteId: "msg-1" });
  });

  it("does not post it again, and says what went up the first time", async () => {
    await postNoticeOnce(env, await target(), "confirmed", confirmedNotice(await target()));
    calls = [];

    const again = await postNoticeOnce(env, await target(), "confirmed", confirmedNotice(await target()));

    // A notice arriving twice is worse than one arriving late, and under
    // send-only the second cannot be taken back.
    expect(again).toBe("msg-1");
    expect(calls).toEqual([]);
  });

  it("keeps its own row per label, so two notices are two notices", async () => {
    await postNoticeOnce(env, await target(), "confirmed", confirmedNotice(await target()));
    await postNoticeOnce(env, await target(), "jeopardy", confirmedNotice(await target()));

    expect(calls).toHaveLength(2);
    expect(await find(env, noticeRef)).toMatchObject({ remoteId: "msg-1" });
    expect(await find(env, { ...noticeRef, label: "jeopardy" })).toMatchObject({
      remoteId: "msg-2",
    });
  });

  it("does not share a row with the attendance post", async () => {
    await postNoticeOnce(env, await target(), "confirmed", confirmedNotice(await target()));

    // The post's id is unlabelled and unchanged — nothing that existed before
    // notices did has moved.
    expect(
      await find(env, { surface: "discord", kind: "message", targetId: SESSION_ID }),
    ).toBeUndefined();
  });

  it("lets the next attempt post when Discord refused this one", async () => {
    postResponse = () => Response.json({ code: 50001, message: "Missing Access" }, { status: 403 });
    await expect(
      postNoticeOnce(env, await target(), "confirmed", confirmedNotice(await target())),
    ).rejects.toThrow();

    // Discord said no, so nothing went up and the claim must not block a retry.
    expect(await find(env, noticeRef)).toBeUndefined();

    postResponse = () => Response.json({ id: "msg-later", channel_id: "chan-1" });
    expect(
      await postNoticeOnce(env, await target(), "confirmed", confirmedNotice(await target())),
    ).toBe("msg-later");
  });

  it("holds the claim when it never heard back", async () => {
    postResponse = () => {
      throw new TypeError("network error");
    };
    await expect(
      postNoticeOnce(env, await target(), "confirmed", confirmedNotice(await target())),
    ).rejects.toThrow();

    const row = await find(env, noticeRef);
    expect(row).toMatchObject({ state: "claimed", remoteId: null });
    expect(row?.lastError).toContain("network error");
  });
});

describe("the crossing arms it", () => {
  it("arms the job in the same batch as the confirmation", async () => {
    await lock().setIntent({ sessionId: SESSION_ID, actor: actor("1"), intent: "in" });
    expect(await jobs()).toEqual([]);

    await lock().setIntent({ sessionId: SESSION_ID, actor: actor("2"), intent: "in" });

    expect(await jobs()).toMatchObject([
      { kind: "session.confirmed-notice", state: "pending" },
    ]);
  });

  it("leaves the confirmation on the record, in the same batch", async () => {
    await lock().setIntent({ sessionId: SESSION_ID, actor: actor("1"), intent: "in" });
    await lock().setIntent({ sessionId: SESSION_ID, actor: actor("2"), intent: "in" });

    // The row the lead-time statistic measures to. It is in the batch with the
    // state it records, so a confirmation cannot commit without it and quietly
    // leave the average.
    const rows = (await db(env).select().from(schema.auditLog).all()).filter(
      (row) => row.action === SESSION_CONFIRMED,
    );
    expect(rows).toHaveLength(1);
    // Nobody decided this — the count did. Attributing it to whoever happened
    // to click the crossing one would read as though they confirmed it.
    expect(rows[0]).toMatchObject({ targetId: SESSION_ID, actorUserId: null });
  });

  it("posts it on the next drain", async () => {
    await lock().setIntent({ sessionId: SESSION_ID, actor: actor("1"), intent: "in" });
    await lock().setIntent({ sessionId: SESSION_ID, actor: actor("2"), intent: "in" });
    calls = [];

    await drainJobs(env);

    expect(calls).toMatchObject([{ path: "/channels/thread-1/messages" }]);
    expect(calls[0]?.body).toMatchObject({ content: expect.stringContaining("It's on.") });
  });

  it("says nothing if the session stopped being confirmed before the drain", async () => {
    await lock().setIntent({ sessionId: SESSION_ID, actor: actor("1"), intent: "in" });
    await lock().setIntent({ sessionId: SESSION_ID, actor: actor("2"), intent: "in" });
    await env.DB.prepare("UPDATE sessions SET state = 'CANCELLED'").run();
    calls = [];

    await drainJobs(env);

    // A notice saying it is on, posted after it was called off, is worse than no
    // notice at all.
    expect(calls).toEqual([]);
  });

  it("arms one job however many clicks cross at once", async () => {
    await Promise.all([
      lock().setIntent({ sessionId: SESSION_ID, actor: actor("1"), intent: "in" }),
      lock().setIntent({ sessionId: SESSION_ID, actor: actor("2"), intent: "in" }),
      lock().setIntent({ sessionId: SESSION_ID, actor: actor("3"), intent: "in" }),
    ]);

    expect(await jobs()).toHaveLength(1);
  });
});

describe("what must not burn the claim", () => {
  it("does not take one when the guild id has never been seeded", async () => {
    await env.DB.prepare("DELETE FROM settings WHERE key = ?").bind(SETTING_KEYS.guildId).run();

    await expect(
      postNoticeOnce(env, await target(), "confirmed", confirmedNotice(await target())),
    ).rejects.toThrow();

    // A claim is expensive to hold — nothing else may post while it stands — so
    // burning one on a missing setting would suppress this notice for good, with
    // no Discord call ever made and nothing to show for it.
    expect(await find(env, noticeRef)).toBeUndefined();
    expect(calls).toEqual([]);
  });

  it("does not take one for a session with nowhere to post", async () => {
    await env.DB.prepare("UPDATE sessions SET thread_id = NULL").run();
    await env.DB.prepare("UPDATE campaigns SET discord_channel_id = NULL").run();

    expect(
      await postNoticeOnce(env, await target(), "confirmed", confirmedNotice(await target())),
    ).toBeUndefined();

    // Taking a claim to say "nowhere" would block the attempt that comes after
    // somebody makes the thread.
    expect(await find(env, noticeRef)).toBeUndefined();
  });
});
