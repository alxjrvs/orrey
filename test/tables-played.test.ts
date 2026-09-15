import { env } from "cloudflare:test";
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { db, schema } from "../src/db/index.ts";
import { SETTING_KEYS, setSetting } from "../src/db/settings.ts";
import { decodeCustomId, encodeCustomId } from "../src/discord/custom-id.ts";
import { InteractionResponseType, InteractionType, MessageFlags } from "../src/discord/types.ts";
import { createApp } from "../src/http/app.ts";
import { registerRows } from "../src/attendance/assume.ts";
import { correctionPost } from "../src/attendance/render.ts";
import { normaliseTablesPlayed, tablesPlayedFor } from "../src/attendance/tables.ts";
import { loadProjectionTarget } from "../src/projection/target.ts";
import { fakeDiscord } from "./discord.ts";

/**
 * The optional field on the correction post.
 *
 * #7 asked whether Orrey should model tables. The answer is one free-text
 * column, filled in by whoever ran the day — so what is worth testing is the
 * guard, the escaping, and that the chain never rewrites the post it started
 * from.
 */
const discord = await fakeDiscord();
const app = createApp();
const START = Date.parse("2026-11-07T18:00:00Z") / 1000;
const DAY_ID = "day-1";
const SESSION_ID = "gd-day-1";
const HOST = "host-1";

async function day(over: Partial<typeof schema.gameDays.$inferInsert> = {}) {
  await db(env)
    .insert(schema.gameDays)
    .values({
      id: DAY_ID,
      kind: "multi",
      title: "November Games Day",
      state: "PLAYED",
      startsAt: START,
      endsAt: START + 18_000,
      hostUserId: HOST,
      ...over,
    });
}

async function session(over: Partial<typeof schema.sessions.$inferInsert> = {}) {
  await db(env)
    .insert(schema.sessions)
    .values({
      id: SESSION_ID,
      kind: "one_off",
      gameDayId: DAY_ID,
      state: "PLAYED",
      startsAt: START,
      endsAt: START + 18_000,
      ...over,
    });
}

async function came(
  userId: string,
  attended = true,
  tablesPlayed: string | null = null,
  name = `Player ${userId}`,
) {
  await db(env)
    .insert(schema.users)
    .values({ discordId: userId, username: userId, globalName: name, feedToken: `t-${userId}` })
    .onConflictDoNothing();
  await db(env)
    .insert(schema.attendance)
    .values({
      sessionId: SESSION_ID,
      userId,
      intent: "in",
      attended: attended ? 1 : 0,
      tablesPlayed,
    });
}

function member(id: string, roles: string[] = []) {
  return { user: { id, username: id, global_name: `Player ${id}` }, roles };
}

async function post(body: unknown) {
  const res = await app.fetch(await discord.request(body), discord.env(env));
  return (await res.json()) as {
    type: number;
    data: { content?: string; flags?: number; components?: unknown[]; custom_id?: string; title?: string };
  };
}

function click(who: string, target = SESSION_ID, roles: string[] = []) {
  return post({
    type: InteractionType.MESSAGE_COMPONENT,
    data: { custom_id: encodeCustomId({ action: "tables", target }), component_type: 2 },
    member: member(who, roles),
    message: { id: "msg-1", channel_id: "chan-1" },
  });
}

function choose(who: string, userId: string) {
  return post({
    type: InteractionType.MESSAGE_COMPONENT,
    data: {
      custom_id: encodeCustomId({ action: "tables-who", target: SESSION_ID }),
      component_type: 3,
      values: [userId],
    },
    member: member(who),
    message: { id: "msg-1", channel_id: "chan-1" },
  });
}

function submit(who: string, userId: string, value: string) {
  return post({
    type: InteractionType.MODAL_SUBMIT,
    data: {
      custom_id: encodeCustomId({ action: "tables-line", arg: userId, target: SESSION_ID }),
      components: [{ components: [{ custom_id: "tables", value }] }],
    },
    member: member(who),
    message: { id: "msg-1", channel_id: "chan-1" },
  });
}

async function target() {
  return (await loadProjectionTarget(env, SESSION_ID))!;
}

function stored(userId: string) {
  return db(env)
    .select({ tablesPlayed: schema.attendance.tablesPlayed })
    .from(schema.attendance)
    .where(
      and(eq(schema.attendance.sessionId, SESSION_ID), eq(schema.attendance.userId, userId)),
    )
    .get();
}

beforeEach(async () => {
  for (const table of [
    "attendance",
    "signups",
    "jobs",
    "sessions",
    "game_days",
    "campaigns",
    "games",
    "users",
    "settings",
  ]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  await db(env)
    .insert(schema.users)
    .values({ discordId: HOST, username: "host", feedToken: "t-host" });
});

describe("the button", () => {
  it("is on a multi day's correction post, in its own row", async () => {
    await day();
    await session();
    await came("p0");

    const payload = correctionPost(await target(), await registerRows(env, SESSION_ID), new Date(), {
      multiDay: true,
    });

    const rows = payload.components as { components: { custom_id: string; label?: string }[] }[];
    expect(rows).toHaveLength(2);
    expect(rows[1]?.components[0]).toMatchObject({ label: "Tables played" });
    expect(decodeCustomId(rows[1]!.components[0]!.custom_id)).toEqual({
      action: "tables",
      target: SESSION_ID,
    });
  });

  it("is absent without the option — a campaign session, or a single day", async () => {
    await day({ kind: "single" });
    await session();
    await came("p0");

    const payload = correctionPost(await target(), await registerRows(env, SESSION_ID), new Date());

    const rows = payload.components as { components: { label?: string }[] }[];
    expect(rows.flatMap((r) => r.components).some((c) => c.label === "Tables played")).toBe(false);
  });

  it("leaves a row free by showing five fewer toggles", async () => {
    await day();
    await session();
    for (let i = 0; i < 25; i++) await came(`p${i}`);
    const register = await registerRows(env, SESSION_ID);

    const plain = correctionPost(await target(), register, new Date());
    const withTables = correctionPost(await target(), register, new Date(), { multiDay: true });

    // Discord allows five rows per message. Dropping five names beats dropping
    // the button: the console can correct a register, and nothing else can
    // record what somebody played.
    expect(plain.components).toHaveLength(5);
    expect(withTables.components).toHaveLength(5);
    expect(withTables.content).toContain("5 more on the roster");
  });
});

describe("what the post shows", () => {
  it("lists the lines under Tables", async () => {
    await day();
    await session();
    await came("p0", true, "Blades, then Fiasco");

    const payload = correctionPost(await target(), await registerRows(env, SESSION_ID), new Date(), {
      multiDay: true,
    });

    expect(payload.content).toContain("**Tables**");
    expect(payload.content).toContain("Player p0 — Blades, then Fiasco");
  });

  it("escapes it, because it is somebody else's text on a post Orrey cannot edit", async () => {
    await day();
    await session();
    await came("p0", true, "**Blades** `and` _Fiasco_");

    const payload = correctionPost(await target(), await registerRows(env, SESSION_ID), new Date(), {
      multiDay: true,
    });

    expect(payload.content).not.toContain("**Blades**");
    expect(payload.content).toContain("\\*\\*Blades\\*\\*");
  });

  it("says nothing at all when nobody has filled one in", async () => {
    await day();
    await session();
    await came("p0");

    const payload = correctionPost(await target(), await registerRows(env, SESSION_ID), new Date(), {
      multiDay: true,
    });

    expect(payload.content).not.toContain("**Tables**");
  });
});

describe("what Discord will accept", () => {
  it("sheds the free text rather than sending a post Discord rejects", async () => {
    await day();
    await session();
    for (let i = 0; i < 20; i++) await came(`p${i}`, true, "T".repeat(140));

    const payload = correctionPost(await target(), await registerRows(env, SESSION_ID), new Date(), {
      multiDay: true,
    });

    // Twenty lines of a hundred and forty characters is three and a half
    // thousand on its own. Over two thousand is not a post that reads badly, it
    // is a post Discord rejects — and `attendance.assume` would retry it into
    // the identical 400 for ever.
    expect(payload.content.length).toBeLessThanOrEqual(1900);
    expect(payload.content).toContain("20 of 20");
    expect(payload.content).toContain("recorded — read them in the console");
    // The toggles are what the post is for; they survive every pass.
    expect((payload.components as unknown[]).length).toBe(5);
  });

  it("sheds the names too, rather than growing past it", async () => {
    await day();
    await session();
    for (let i = 0; i < 20; i++) {
      await came(`p${i}`, true, "T".repeat(140), `Player ${i} `.padEnd(90, "x"));
    }

    const payload = correctionPost(await target(), await registerRows(env, SESSION_ID), new Date(), {
      multiDay: true,
    });

    expect(payload.content.length).toBeLessThanOrEqual(1900);
    expect(payload.content).toContain("20 of 20");
  });

  it("leaves an ordinary post exactly as it was", async () => {
    await day();
    await session();
    await came("p0", true, "Blades, then Fiasco");

    const payload = correctionPost(await target(), await registerRows(env, SESSION_ID), new Date(), {
      multiDay: true,
    });

    expect(payload.content).toContain("Player p0 — Blades, then Fiasco");
  });
});

describe("Refresh", () => {
  it("is on the post, beside Tables played", async () => {
    await day();
    await session();
    await came("p0");

    const payload = correctionPost(await target(), await registerRows(env, SESSION_ID), new Date(), {
      multiDay: true,
    });

    const rows = payload.components as { components: { custom_id: string; label?: string }[] }[];
    expect(rows.at(-1)?.components.map((c) => c.label)).toEqual(["Tables played", "Refresh"]);
  });

  it("rewrites the post it came from, with the lines on it", async () => {
    await day();
    await session();
    await came("p0", true, "Blades, then Fiasco");

    const answer = await post({
      type: InteractionType.MESSAGE_COMPONENT,
      data: {
        custom_id: encodeCustomId({
          action: "correction",
          arg: "refresh",
          target: SESSION_ID,
        }),
        component_type: 2,
      },
      member: member("anybody"),
      message: { id: "msg-1", channel_id: "chan-1" },
    });

    // What "it will be on the post on its next Refresh" means. Without this
    // there is no next render of this post at all.
    expect(answer.type).toBe(InteractionResponseType.UPDATE_MESSAGE);
    expect(answer.data.content).toContain("Player p0 — Blades, then Fiasco");
  });

  it("degrades to the retired-post response for a session that is gone", async () => {
    const answer = await post({
      type: InteractionType.MESSAGE_COMPONENT,
      data: {
        custom_id: encodeCustomId({ action: "correction", arg: "refresh", target: "nowhere" }),
        component_type: 2,
      },
      member: member("anybody"),
      message: { id: "msg-1", channel_id: "chan-1" },
    });

    expect(answer.data.content).toContain("retired");
  });
});

describe("the chain", () => {
  it("offers the people marked as having come", async () => {
    await day();
    await session();
    await came("p0");
    await came("p1", false);

    const answer = await click(HOST);

    expect(answer.type).toBe(InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE);
    expect(answer.data.flags! & MessageFlags.EPHEMERAL).toBeTruthy();
    const select = (answer.data.components as { components: { options: { value: string }[] }[] }[])[0]!
      .components[0]!;
    expect(select.options.map((option) => option.value)).toEqual(["p0"]);
  });

  it("opens a modal prefilled from D1, never from the message", async () => {
    await day();
    await session();
    await came("p0", true, "Blades");

    const answer = await choose(HOST, "p0");

    expect(answer.type).toBe(InteractionResponseType.MODAL);
    const input = (answer.data.components as { components: { value: string }[] }[])[0]!
      .components[0]!;
    expect(input.value).toBe("Blades");
    expect(decodeCustomId(answer.data.custom_id!)).toEqual({
      action: "tables-line",
      arg: "p0",
      target: SESSION_ID,
    });
  });

  it("stores what was submitted and says so ephemerally", async () => {
    await day();
    await session();
    await came("p0");

    const answer = await submit(HOST, "p0", "  Blades,   then Fiasco\n");

    expect(await stored("p0")).toMatchObject({ tablesPlayed: "Blades, then Fiasco" });
    expect(answer.type).toBe(InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE);
    expect(answer.data.flags! & MessageFlags.EPHEMERAL).toBeTruthy();
    // Never UPDATE_MESSAGE: the post it started from belongs to everybody using
    // its toggles, and rewriting it would replace them with one person's select.
    expect(answer.type).not.toBe(InteractionResponseType.UPDATE_MESSAGE);
  });

  it("clears it on an empty box", async () => {
    await day();
    await session();
    await came("p0", true, "Blades");

    await submit(HOST, "p0", "   ");

    expect(await stored("p0")).toMatchObject({ tablesPlayed: null });
  });

  it("records nothing for somebody who was never on the register", async () => {
    await day();
    await session();
    await came("p0");

    await submit(HOST, "stranger", "Blades");

    // Inventing a row here would be recording attendance through the side door.
    expect(await stored("stranger")).toBeUndefined();
  });

  it("says there is nothing to record when nobody came", async () => {
    await day();
    await session();
    await came("p0", false);

    expect((await click(HOST)).data.content).toContain("nothing to record");
  });
});

describe("who may", () => {
  it("refuses anybody but whoever ran the day", async () => {
    await day();
    await session();
    await came("p0");

    const answer = await click("p0");

    expect(answer.data.content).toContain("Only whoever ran the day");
    expect(answer.data.flags! & MessageFlags.EPHEMERAL).toBeTruthy();
  });

  it("refuses the modal too, not only the button", async () => {
    await day();
    await session();
    await came("p0");

    await submit("p0", "p0", "Blades");

    // The guard is on every step: a person who has seen the modal id once must
    // not be able to submit it forever.
    expect(await stored("p0")).toMatchObject({ tablesPlayed: null });
  });

  it("lets an organiser record it on a day with no host", async () => {
    await day({ hostUserId: null });
    await session();
    await came("p0");
    await setSetting(env, SETTING_KEYS.organiserRoleId, "role-org");

    // Nothing writes `host_user_id` yet, so a day with no host is every day.
    // Refusing here would refuse the feature, and the console page the old
    // refusal named does not exist.
    const answer = await click("somebody", SESSION_ID, ["role-org"]);
    expect(answer.data.content).not.toContain("Only an organiser");
    expect(answer.data.components).toBeDefined();
  });

  it("still refuses somebody with no role on a day with no host", async () => {
    await day({ hostUserId: null });
    await session();
    await came("p0");
    await setSetting(env, SETTING_KEYS.organiserRoleId, "role-org");

    expect((await click("somebody")).data.content).toContain("Only an organiser");
  });

  it("fails closed when the organiser role has never been seeded", async () => {
    await day({ hostUserId: null });
    await session();
    await came("p0");

    // An unseeded role id means nobody, which somebody notices.
    expect((await click(HOST, SESSION_ID, ["role-org"])).data.content).toContain(
      "Only an organiser",
    );
  });

  it("degrades a campaign session's click to the retired-post response", async () => {
    await db(env)
      .insert(schema.campaigns)
      .values({ id: "c1", name: "Age of Umbra", kind: "run", state: "RUNNING" });
    await db(env)
      .insert(schema.sessions)
      .values({
        id: "c1-s1",
        kind: "campaign_session",
        campaignId: "c1",
        number: 1,
        startsAt: START,
        endsAt: START + 3600,
      });

    const answer = await click(HOST, "c1-s1");
    expect(answer.data.flags! & MessageFlags.EPHEMERAL).toBeTruthy();
    expect(answer.data.content).not.toContain("Who do you want");
  });
});

describe("the id budget", () => {
  it("fits Discord's hundred characters, with a real Discord user id", () => {
    const id = encodeCustomId({
      action: "tables-line",
      arg: "123456789012345678",
      target: "gd-abcdefghijkl",
    });
    expect(id.length).toBeLessThanOrEqual(100);
  });
});

describe("normalising", () => {
  it("is one line, trimmed, and capped", () => {
    expect(normaliseTablesPlayed("  Blades\n\nthen   Fiasco ")).toBe("Blades then Fiasco");
    expect(normaliseTablesPlayed("   ")).toBeNull();
    expect(normaliseTablesPlayed("x".repeat(300))?.length).toBe(140);
  });

  it("reads back what was stored", async () => {
    await day();
    await session();
    await came("p0", true, "Blades");
    expect(await tablesPlayedFor(env, SESSION_ID, "p0")).toBe("Blades");
  });
});
