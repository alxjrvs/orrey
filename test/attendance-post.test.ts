import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db, schema } from "../src/db/index.ts";
import { SETTING_KEYS, setSetting } from "../src/db/settings.ts";
import { seedStatements } from "../src/db/seed-sql.ts";
import { decodeCustomId } from "../src/discord/custom-id.ts";
import { postAttendancePost } from "../src/attendance/post.ts";
import { attendanceRows } from "../src/attendance/rows.ts";
import { renderAttendancePost, type AttendanceRow } from "../src/attendance/render.ts";
import { loadProjectionTarget, type ProjectionTarget } from "../src/projection/target.ts";

const realFetch = globalThis.fetch;
let posts: { path: string; body: Record<string, unknown> }[] = [];

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
const asOf = new Date("2026-09-18T12:00:00Z");

async function seed(): Promise<void> {
  for (const statement of seedStatements(campaign, session)) {
    await env.DB.prepare(statement).run();
  }
}

async function target(): Promise<ProjectionTarget> {
  return (await loadProjectionTarget(env, SESSION_ID))!;
}

function render(rows: AttendanceRow[], over: Partial<ProjectionTarget> = {}) {
  return async () => renderAttendancePost({ target: { ...(await target()), ...over }, rows, asOf });
}

const row = (
  userId: string,
  name: string,
  intent: AttendanceRow["intent"],
  note: string | null = null,
): AttendanceRow => ({ userId, name, intent, note });

beforeEach(async () => {
  posts = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    posts.push({
      path: url.pathname.replace("/api/v10", ""),
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
    });
    return Response.json({ id: `msg-${posts.length}`, channel_id: "chan-1" });
  }) as typeof fetch;

  // The post is guarded by a claim in `publications` now (#73), so a claim left
  // by the previous case would stop the next one posting at all.
  await env.DB.prepare("DELETE FROM publications").run();
  await env.DB.prepare("DELETE FROM attendance").run();
  await env.DB.prepare("DELETE FROM jobs").run();
  await env.DB.prepare("DELETE FROM sessions").run();
  await env.DB.prepare("DELETE FROM campaigns").run();
  await env.DB.prepare("DELETE FROM users").run();
  await env.DB.prepare("DELETE FROM settings").run();
  await setSetting(env, SETTING_KEYS.guildId, "g1");
  await seed();
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("rendering the post", () => {
  it("reads as a snapshot: who, when, and when it was true", async () => {
    const payload = await render([
      row("1", "Ada", "in"),
      row("2", "Bob", "in"),
      row("3", "Carol", "out"),
      row("4", "Dan", "maybe"),
    ])();

    expect(payload.content).toContain("<@&role-1> **Age of Umbra — Session 12**");
    expect(payload.content).toContain(`<t:${session.startsAt}:F> → <t:${session.endsAt}:t>`);
    expect(payload.content).toContain("The Wreck");
    expect(payload.content).toContain("**In (2)** — Ada, Bob");
    expect(payload.content).toContain("**Out (1)** — Carol");
    expect(payload.content).toContain("**Maybe (1)** — Dan");
    // The as-of line is the whole apology for a post that cannot be edited.
    expect(payload.content).toContain(`As of <t:${Math.floor(asOf.getTime() / 1000)}:R>`);
  });

  it("is a pure function of its rows and its clock", async () => {
    const rows = [row("1", "Ada", "in")];
    expect(await render(rows)()).toEqual(await render(rows)());
  });

  it("says so plainly when nobody has answered", async () => {
    expect((await render([])()).content).toContain("Nobody has said yet");
    expect((await render([row("1", "Ada", null)])()).content).toContain("Nobody has said yet");
  });

  it("shows a note beside the name that left it", async () => {
    const payload = await render([row("1", "Ada", "maybe", "might be 30 late")])();
    expect(payload.content).toContain("Ada (might be 30 late)");
  });

  it("mentions the roster role and nothing else", async () => {
    const payload = await render([row("1", "Ada", "in", "@everyone should come")])();
    expect(payload.allowed_mentions).toEqual({ parse: [], roles: ["role-1"] });
  });

  it("carries five buttons whose ids Orrey can read back", async () => {
    const payload = await render([])();
    const buttons = (payload.components[0] as { components: { label: string; custom_id: string }[] })
      .components;

    expect(buttons.map((b) => b.label)).toEqual(["In", "Out", "Maybe", "Note", "Refresh"]);
    for (const button of buttons) {
      expect(button.custom_id.length).toBeLessThanOrEqual(100);
      expect(decodeCustomId(button.custom_id)).toMatchObject({ action: "attend", target: SESSION_ID });
    }
  });
});

describe("staying inside Discord's message ceiling", () => {
  it("drops the notes, then the names, rather than growing past the limit", async () => {
    const crowd = (n: number, note: string | null) =>
      Array.from({ length: n }, (_, i) => row(String(i), `Person Number ${i}`, "in", note));

    const small = await render(crowd(4, "a short note"))();
    expect(small.content).toContain("a short note");

    // Notes go first...
    const many = await render(crowd(40, "x".repeat(140)))();
    expect(many.content.length).toBeLessThanOrEqual(1900);
    expect(many.content).toContain("**In (40)** — Person Number 0");
    expect(many.content).not.toContain("xxx");

    // ...then the names, leaving the count, which is the actual answer.
    const crowded = await render(crowd(400, null))();
    expect(crowded.content.length).toBeLessThanOrEqual(1900);
    expect(crowded.content).toContain("**In (400)**");
    expect(crowded.content).not.toContain("Person Number 399");
    // Whatever is dropped, the as-of line and its promise survive.
    expect(crowded.content).toMatch(/As of <t:\d+:R>/);
  });

  it("escapes a name as well as a note", async () => {
    const payload = await render([row("1", "**Ada**", "in")])();
    expect(payload.content).toContain("\\*\\*Ada\\*\\*");
  });
});

describe("posting it", () => {
  it("posts to the campaign channel and records the message id", async () => {
    const id = await postAttendancePost(env, SESSION_ID);

    expect(posts).toHaveLength(1);
    expect(posts[0]?.path).toBe("/channels/chan-1/messages");
    expect(posts[0]?.body.content).toContain("Age of Umbra — Session 12");
    expect(id).toBe("msg-1");
    expect((await db(env).select().from(schema.sessions).get())?.discordMessageId).toBe("msg-1");
  });

  it("posts once: a re-run finds the id and sends nothing", async () => {
    await postAttendancePost(env, SESSION_ID);
    posts = [];

    expect(await postAttendancePost(env, SESSION_ID)).toBe("msg-1");
    expect(posts).toEqual([]);
  });

  it("falls back to the scheduling channel when the campaign has none", async () => {
    await env.DB.prepare("UPDATE campaigns SET discord_channel_id = NULL").run();
    await setSetting(env, SETTING_KEYS.schedulingChannelId, "chan-fallback");

    await postAttendancePost(env, SESSION_ID);
    expect(posts[0]?.path).toBe("/channels/chan-fallback/messages");
  });

  it("refuses to guess a channel when there is none", async () => {
    await env.DB.prepare("UPDATE campaigns SET discord_channel_id = NULL").run();
    await expect(postAttendancePost(env, SESSION_ID)).rejects.toThrow(/no channel/);
    expect(posts).toEqual([]);
  });

  it("renders the people who have answered, newest answer last", async () => {
    const d = db(env);
    await d.insert(schema.users).values([
      { discordId: "1", username: "ada", globalName: "Ada", feedToken: "t1" },
      { discordId: "2", username: "bob", globalName: null, feedToken: "t2" },
    ]);
    await d.insert(schema.attendance).values([
      { sessionId: SESSION_ID, userId: "1", intent: "in", updatedAt: 1_000 },
      { sessionId: SESSION_ID, userId: "2", intent: "out", updatedAt: 2_000 },
    ]);

    expect(await attendanceRows(env, SESSION_ID)).toEqual([
      { userId: "1", name: "Ada", intent: "in", note: null },
      { userId: "2", name: "bob", intent: "out", note: null },
    ]);
  });
});
