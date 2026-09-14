import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { db, schema } from "../src/db/index.ts";
import { addSessionLog, normaliseLogBody, sessionLogs } from "../src/logs/session-log.ts";

/**
 * One table, and one way to write to it.
 *
 * Two things here are not obvious and both are the point: the order two recaps
 * written in the same second come back in, and the fact that a recap keeps its
 * newlines where a note does not.
 */
const SESSION_ID = "umbra-s12";
const START = Math.floor(Date.parse("2026-09-20T18:00:00Z") / 1000);

async function seed() {
  await db(env)
    .insert(schema.campaigns)
    .values({ id: "umbra", name: "Age of Umbra", kind: "run", state: "RUNNING" });
  await db(env)
    .insert(schema.sessions)
    .values({
      id: SESSION_ID,
      kind: "campaign_session",
      campaignId: "umbra",
      number: 12,
      startsAt: START,
      endsAt: START + 4 * 3600,
    });
  for (const id of ["ada", "bea"]) {
    await db(env)
      .insert(schema.users)
      .values({ discordId: id, username: id, feedToken: `t-${id}` })
      .onConflictDoNothing();
  }
}

beforeEach(async () => {
  for (const table of ["session_logs", "attendance", "sessions", "campaigns", "users"]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  await seed();
});

describe("the order they come back in", () => {
  it("is the order they were written, inside the same second", async () => {
    // `created_at` is whole seconds, so all three of these sort equal on it.
    // Without a monotonic id this is a stable *arbitrary* order rather than the
    // right one, and a log is the one table where the order is the content.
    for (const body of ["first", "second", "third"]) {
      await addSessionLog(env, { sessionId: SESSION_ID, authorId: "ada", body });
    }

    expect((await sessionLogs(env, SESSION_ID)).map((row) => row.body)).toEqual([
      "first",
      "second",
      "third",
    ]);
  });

  it("puts an older second before a newer one whatever the ids say", async () => {
    const later = await addSessionLog(env, { sessionId: SESSION_ID, authorId: "ada", body: "later" });
    const earlier = await addSessionLog(env, {
      sessionId: SESSION_ID,
      authorId: "bea",
      body: "earlier",
    });
    // Backdate the second write by an hour, relative to its own stamp — the
    // row's `created_at` is the real clock, not this file's fixture date, so
    // "an hour before START" would still have been in the future.
    await env.DB.prepare("UPDATE session_logs SET created_at = created_at - 3600 WHERE id = ?")
      .bind(earlier!.id)
      .run();

    expect((await sessionLogs(env, SESSION_ID)).map((row) => row.id)).toEqual([
      earlier!.id,
      later!.id,
    ]);
  });

  it("is only this session's log", async () => {
    await db(env)
      .insert(schema.sessions)
      .values({
        id: "umbra-s13",
        kind: "campaign_session",
        campaignId: "umbra",
        number: 13,
        startsAt: START + 86_400,
        endsAt: START + 86_400 + 4 * 3600,
      });
    await addSessionLog(env, { sessionId: SESSION_ID, authorId: "ada", body: "twelve" });
    await addSessionLog(env, { sessionId: "umbra-s13", authorId: "ada", body: "thirteen" });

    expect((await sessionLogs(env, SESSION_ID)).map((row) => row.body)).toEqual(["twelve"]);
  });
});

describe("what a recap keeps", () => {
  it("keeps its newlines, where a note would not", async () => {
    // A note is rendered inline on a post Orrey can never edit, so a newline
    // there breaks that post's layout permanently. A recap is a message of its
    // own, and a paragraph break is part of what somebody wrote.
    expect(normaliseLogBody("They took the Wreck.\n\nThen the tide came in.")).toBe(
      "They took the Wreck.\n\nThen the tide came in.",
    );
  });

  it("loses trailing whitespace, blank-line runs, and the blank space around it", async () => {
    expect(normaliseLogBody("  \n\nkept   \n\n\n\nalso kept\t\n  \n ")).toBe("kept\n\nalso kept");
  });

  it("is nothing at all when nothing was written", async () => {
    expect(normaliseLogBody("   \n\n  ")).toBeNull();
    expect(await addSessionLog(env, { sessionId: SESSION_ID, authorId: "ada", body: " " })).toBeUndefined();
    expect(await sessionLogs(env, SESSION_ID)).toEqual([]);
  });

  it("stores it normalised rather than normalising on the way out", async () => {
    await addSessionLog(env, { sessionId: SESSION_ID, authorId: "ada", body: "  a\t\n\n\n\nb  " });
    expect((await sessionLogs(env, SESSION_ID))[0]?.body).toBe("a\n\nb");
  });
});

describe("what takes it with it", () => {
  it("the session", async () => {
    await addSessionLog(env, { sessionId: SESSION_ID, authorId: "ada", body: "a recap" });

    await env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(SESSION_ID).run();

    const left = await env.DB.prepare("SELECT COUNT(*) AS n FROM session_logs").first<{ n: number }>();
    expect(left?.n).toBe(0);
  });

  it("the author", async () => {
    await addSessionLog(env, { sessionId: SESSION_ID, authorId: "ada", body: "ada wrote this" });
    await addSessionLog(env, { sessionId: SESSION_ID, authorId: "bea", body: "bea wrote this" });

    await env.DB.prepare("DELETE FROM users WHERE discord_id = ?").bind("ada").run();

    expect((await sessionLogs(env, SESSION_ID)).map((row) => row.body)).toEqual(["bea wrote this"]);
  });
});
