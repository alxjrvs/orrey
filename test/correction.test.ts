import { env } from "cloudflare:test";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db, schema } from "../src/db/index.ts";
import { SETTING_KEYS, setSetting } from "../src/db/settings.ts";
import { seedStatements } from "../src/db/seed-sql.ts";
import { createApp } from "../src/http/app.ts";
import { encodeCustomId, decodeCustomId } from "../src/discord/custom-id.ts";
import { InteractionResponseType, InteractionType } from "../src/discord/types.ts";
import { drainJobs } from "../src/jobs/drain.ts";
import { armAssume } from "../src/attendance/assume.ts";
import { fakeDiscord } from "./discord.ts";

/**
 * The register is what flake memory reads, so a register anybody can edit is a
 * register nobody can rely on. These are mostly about who may not touch it.
 */
const discord = await fakeDiscord();
const app = createApp();
const realFetch = globalThis.fetch;
const SESSION_ID = "age-of-umbra-s12";
const STARTS_AT = Date.parse("2026-09-20T19:00:00Z") / 1000;
const GM = "gm-1";

let posts: { path: string; body: Record<string, unknown> }[] = [];

const campaign = {
  name: "Age of Umbra",
  kind: "run",
  discordChannelId: "chan-1",
  discordRoleId: "role-1",
} as const;

const session = { number: 12, startsAt: STARTS_AT, endsAt: STARTS_AT + 4 * 3600, location: "The Wreck" };

interface Reply {
  type: number;
  data: { content?: string; components?: { components: { custom_id: string; label: string }[] }[] };
}

async function click(customId: string, userId: string): Promise<Reply> {
  const res = await app.fetch(
    await discord.request({
      type: InteractionType.MESSAGE_COMPONENT,
      data: { custom_id: customId, component_type: 2 },
      member: { user: { id: userId, username: userId }, roles: [] },
      message: { id: "m1", channel_id: "thread-1" },
    }),
    discord.env(env),
  );
  expect(res.status).toBe(200);
  return (await res.json()) as Reply;
}

async function member(id: string, role: "gm" | "player", intent: "in" | "out" | null) {
  await db(env)
    .insert(schema.users)
    .values({ discordId: id, username: id, globalName: id, feedToken: `t-${id}` })
    .onConflictDoNothing();
  await db(env)
    .insert(schema.campaignMembers)
    .values({ campaignId: "age-of-umbra", userId: id, role });
  if (intent !== null) {
    await db(env)
      .insert(schema.attendance)
      .values({ sessionId: SESSION_ID, userId: id, intent });
  }
}

function register(userId: string) {
  return db(env)
    .select()
    .from(schema.attendance)
    .where(and(eq(schema.attendance.sessionId, SESSION_ID), eq(schema.attendance.userId, userId)))
    .get();
}

const toggleFor = (userId: string) =>
  encodeCustomId({ action: "attended", arg: userId, target: SESSION_ID });

beforeEach(async () => {
  posts = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    posts.push({
      path: url.pathname.replace("/api/v10", ""),
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
    });
    return Response.json({ id: `msg-${posts.length}`, channel_id: "thread-1" });
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

describe("the post", () => {
  it("goes up when the session is assumed, with a toggle each", async () => {
    await member(GM, "gm", "in");
    await member("p-1", "player", "in");
    await member("p-2", "player", null);
    await armAssume(env, SESSION_ID, Math.floor(Date.now() / 1000) - 60);

    await drainJobs(env);

    const post = posts.at(-1)!;
    expect(post.path).toBe("/channels/thread-1/messages");
    expect(post.body.content).toContain("Who came?");
    expect(post.body.content).toContain("2 of 3");

    const buttons = (post.body.components as { components: { custom_id: string }[] }[])
      .flatMap((row) => row.components);
    expect(buttons).toHaveLength(3);
    expect(buttons.map((b) => decodeCustomId(b.custom_id)?.arg).sort()).toEqual([
      GM,
      "p-1",
      "p-2",
    ]);
  });

  it("says nothing for a session nobody was on", async () => {
    await armAssume(env, SESSION_ID, Math.floor(Date.now() / 1000) - 60);
    await drainJobs(env);

    // A post with no buttons is a post that says nothing.
    expect(posts).toEqual([]);
  });

  it("is posted once, however often the job runs", async () => {
    await member(GM, "gm", "in");
    await armAssume(env, SESSION_ID, Math.floor(Date.now() / 1000) - 60);
    await drainJobs(env);

    await armAssume(env, SESSION_ID, Math.floor(Date.now() / 1000) - 60);
    await drainJobs(env);

    expect(posts).toHaveLength(1);
  });
});

describe("the toggle", () => {
  beforeEach(async () => {
    await member(GM, "gm", "in");
    await member("p-1", "player", "out");
    await armAssume(env, SESSION_ID, Math.floor(Date.now() / 1000) - 60);
    await drainJobs(env);
  });

  it("flips one person and says a person decided it", async () => {
    expect(await register("p-1")).toMatchObject({ attended: 0, attendedSource: "auto" });

    const reply = await click(toggleFor("p-1"), GM);

    expect(reply.type).toBe(InteractionResponseType.UPDATE_MESSAGE);
    expect(await register("p-1")).toMatchObject({ attended: 1, attendedSource: "gm" });
  });

  it("rewrites its own message with what was just written", async () => {
    const reply = await click(toggleFor("p-1"), GM);

    expect(reply.data.content).toContain("2 of 2");
    const buttons = reply.data.components!.flatMap((row) => row.components);
    expect(buttons.find((b) => decodeCustomId(b.custom_id)?.arg === "p-1")?.label).toContain("✓");
  });

  it("flips back", async () => {
    await click(toggleFor("p-1"), GM);
    await click(toggleFor("p-1"), GM);

    expect(await register("p-1")).toMatchObject({ attended: 0, attendedSource: "gm" });
  });

  it("turns away anybody who is not running it, and says why", async () => {
    const reply = await click(toggleFor("p-1"), "p-1");

    // A button that appears to do nothing reads as broken rather than as
    // forbidden, so this is a sentence and not a silent no-op.
    expect(reply.type).toBe(InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE);
    expect(reply.data.content).toContain("Only whoever ran the session");
    expect(await register("p-1")).toMatchObject({ attended: 0, attendedSource: "auto" });
  });

  it("survives the assume job running again afterwards", async () => {
    await click(toggleFor("p-1"), GM);

    await armAssume(env, SESSION_ID, Math.floor(Date.now() / 1000) - 60);
    await drainJobs(env);

    // `gm` is the point of the flag: it is what stops a re-run putting Orrey's
    // guess back over somebody's answer.
    expect(await register("p-1")).toMatchObject({ attended: 1, attendedSource: "gm" });
  });

  it("degrades to the retired-post response for a session that is gone", async () => {
    await env.DB.prepare("DELETE FROM sessions").run();

    const reply = await click(toggleFor("p-1"), GM);
    expect(reply.data.content).toContain("retired");
  });
});
