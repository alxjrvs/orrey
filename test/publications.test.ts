import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db, schema } from "../src/db/index.ts";
import { SETTING_KEYS, setSetting } from "../src/db/settings.ts";
import { seedStatements } from "../src/db/seed-sql.ts";
import { postAttendancePost } from "../src/attendance/post.ts";
import {
  claim,
  find,
  publicationId,
  record,
  release,
  retract,
  standing,
  type PublicationRef,
} from "../src/projection/publications.ts";

/**
 * #73: Orrey can lose the only record of something it published. These are the
 * two halves of the answer — a ledger that does not cascade, and a claim written
 * before the call rather than an id written after it.
 */
const realFetch = globalThis.fetch;
let posts: { path: string; body: Record<string, unknown> }[] = [];
/** What Discord answers the next POST with. Default: a message. */
let answer: () => Response = () => Response.json({ id: "msg-1", channel_id: "chan-1" });

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

const SESSION_ID = "age-of-umbra-s12";
const messageRef: PublicationRef = {
  surface: "discord",
  kind: "message",
  targetId: SESSION_ID,
};

async function seed(): Promise<void> {
  for (const statement of seedStatements(campaign, session)) {
    await env.DB.prepare(statement).run();
  }
}

function messageIdOf(): Promise<string | null | undefined> {
  return db(env)
    .select({ id: schema.sessions.discordMessageId })
    .from(schema.sessions)
    .where(eq(schema.sessions.id, SESSION_ID))
    .get()
    .then((row) => row?.id);
}

beforeEach(async () => {
  posts = [];
  answer = () => Response.json({ id: "msg-1", channel_id: "chan-1" });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    posts.push({
      path: url.pathname.replace("/api/v10", ""),
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
    });
    return answer();
  }) as typeof fetch;

  await env.DB.prepare("DELETE FROM publications").run();
  await env.DB.prepare("DELETE FROM calendar_links").run();
  await env.DB.prepare("DELETE FROM attendance").run();
  await env.DB.prepare("DELETE FROM jobs").run();
  await env.DB.prepare("DELETE FROM sessions").run();
  await env.DB.prepare("DELETE FROM campaigns").run();
  await env.DB.prepare("DELETE FROM users").run();
  await env.DB.prepare("DELETE FROM settings").run();
  await setSetting(env, SETTING_KEYS.guildId, "g1");
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("the ledger", () => {
  it("gives the claim to exactly one caller", async () => {
    const first = await claim(env, messageRef, "chan-1");
    const second = await claim(env, messageRef, "chan-1");

    expect(first.mine).toBe(true);
    expect(second.mine).toBe(false);
    // Not an error — the second caller needs the row to decide what to do.
    expect(second.publication.id).toBe(first.publication.id);
    expect(second.publication.state).toBe("claimed");
  });

  it("derives the id, so one thing cannot be claimed under two names", () => {
    expect(publicationId(messageRef)).toBe(`discord:message:${SESSION_ID}`);
    expect(publicationId({ ...messageRef, kind: "event" })).not.toBe(publicationId(messageRef));
  });

  it("records an id for a caller that never claimed", async () => {
    // The event projectors' path. Their upsert is already idempotent against a
    // known id, so they have no window to guard and never claim — and a `record`
    // that only updated would write nothing at all for them, which is exactly
    // the loss this table exists to prevent.
    const eventRef: PublicationRef = { surface: "google", kind: "event", targetId: SESSION_ID };
    await record(env, eventRef, "gcal-1");

    expect(await find(env, eventRef)).toMatchObject({ state: "published", remoteId: "gcal-1" });
    expect(await standing(env, SESSION_ID)).toHaveLength(1);
  });

  it("keeps the remote id after a retraction", async () => {
    await claim(env, messageRef);
    await record(env, messageRef, "msg-9");
    await retract(env, messageRef);

    const row = await find(env, messageRef);
    expect(row).toMatchObject({ state: "retracted", remoteId: "msg-9" });
    // And it is no longer standing, so nothing tries to take it down twice.
    expect(await standing(env, SESSION_ID)).toHaveLength(0);
  });

  it("outlives the session row, where calendar_links does not", async () => {
    await seed();
    await claim(env, messageRef);
    await record(env, messageRef, "msg-9");
    await db(env)
      .insert(schema.calendarLinks)
      .values({ sessionId: SESSION_ID, gcalEventId: "gcal-1" });

    await env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(SESSION_ID).run();

    // The cascade took the Google link — the exact loss #73 names.
    expect(await db(env).select().from(schema.calendarLinks).all()).toHaveLength(0);
    // The ledger did not go with it, so a retraction still knows what is up.
    expect(await standing(env, SESSION_ID)).toMatchObject([{ remoteId: "msg-9" }]);
  });

  it("releases a claim that never became anything", async () => {
    await claim(env, messageRef);
    await release(env, messageRef);
    expect(await find(env, messageRef)).toBeUndefined();

    // A published row is not a claim and is never released by it.
    await claim(env, messageRef);
    await record(env, messageRef, "msg-9");
    await release(env, messageRef);
    expect(await find(env, messageRef)).toMatchObject({ state: "published" });
  });
});

describe("the attendance post, under #73", () => {
  it("posts once and records both the ledger and the session", async () => {
    await seed();
    expect(await postAttendancePost(env, SESSION_ID)).toBe("msg-1");

    expect(posts.map((p) => p.path)).toEqual(["/channels/chan-1/messages"]);
    expect(await find(env, messageRef)).toMatchObject({
      state: "published",
      remoteId: "msg-1",
      channelId: "chan-1",
    });
    expect(await messageIdOf()).toBe("msg-1");
  });

  it("heals from the ledger when the session write was the thing that failed", async () => {
    await seed();
    // Exactly the crash window: the message is up and recorded, and the
    // `sessions` write never happened.
    await claim(env, messageRef, "chan-1");
    await record(env, messageRef, "msg-already-up");

    expect(await postAttendancePost(env, SESSION_ID)).toBe("msg-already-up");

    // The cure is the id, not a second post with live buttons.
    expect(posts).toHaveLength(0);
    expect(await messageIdOf()).toBe("msg-already-up");
  });

  it("refuses to post again behind a claim it cannot account for", async () => {
    await seed();
    // A previous attempt reached Discord and we never learned the outcome.
    await claim(env, messageRef, "chan-1");

    expect(await postAttendancePost(env, SESSION_ID)).toBeUndefined();
    expect(posts).toHaveLength(0);
    expect(await messageIdOf()).toBeNull();
  });

  it("lets the next run post when Discord answered and refused", async () => {
    await seed();
    answer = () => Response.json({ code: 50001, message: "Missing Access" }, { status: 403 });

    await expect(postAttendancePost(env, SESSION_ID)).rejects.toThrow();
    // Discord said no, so nothing went up and the claim must not block a retry.
    expect(await find(env, messageRef)).toBeUndefined();

    answer = () => Response.json({ id: "msg-2", channel_id: "chan-1" });
    expect(await postAttendancePost(env, SESSION_ID)).toBe("msg-2");
  });

  it("holds the claim when Discord answers 500, which may still have posted", async () => {
    await seed();
    answer = () => Response.json({ message: "Internal Server Error" }, { status: 500 });

    await expect(postAttendancePost(env, SESSION_ID)).rejects.toThrow();

    // A 500 is not a refusal. Discord may have created the message and then
    // failed to tell us, and a second post with live buttons cannot be undone.
    expect(await find(env, messageRef)).toMatchObject({ state: "claimed", remoteId: null });
  });

  it("does not burn the claim on a failure that never reached Discord", async () => {
    await seed();
    // The guild id is what `requireGuildId` needs, and without it the post
    // throws before any call is made. Burning a claim there would suppress this
    // post for good: the retry would find a claim, return undefined, and the job
    // would be marked done.
    await env.DB.prepare("DELETE FROM settings").run();

    await expect(postAttendancePost(env, SESSION_ID)).rejects.toThrow();
    expect(await find(env, messageRef)).toBeUndefined();

    await setSetting(env, SETTING_KEYS.guildId, "g1");
    expect(await postAttendancePost(env, SESSION_ID)).toBe("msg-1");
  });

  it("holds the claim when it never heard back at all", async () => {
    await seed();
    answer = () => {
      throw new TypeError("network error");
    };

    await expect(postAttendancePost(env, SESSION_ID)).rejects.toThrow();

    // Not hearing back is not the same as it not having happened, and a
    // duplicate post cannot be tidied away. The claim stays, with the reason.
    const row = await find(env, messageRef);
    expect(row).toMatchObject({ state: "claimed", remoteId: null });
    expect(row?.lastError).toContain("network error");
  });
});
