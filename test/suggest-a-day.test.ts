import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { db, schema } from "../src/db/index.ts";
import { SETTING_KEYS, setSetting } from "../src/db/settings.ts";
import { seedStatements } from "../src/db/seed-sql.ts";
import { createApp } from "../src/http/app.ts";
import { InteractionResponseType, InteractionType } from "../src/discord/types.ts";
import { decodeCustomId, encodeCustomId } from "../src/discord/custom-id.ts";
import { fakeDiscord } from "./discord.ts";
import { loadProjectionTarget } from "../src/projection/target.ts";
import { renderAttendancePost, jeopardyNotice } from "../src/attendance/render.ts";
import { suggestButton } from "../src/polls/buttons.ts";

/**
 * The same modal, from the post it concerns. One mint, two places — and adding a
 * row must not disturb the five ids already on the first.
 */
const discord = await fakeDiscord();
const app = createApp();
const SESSION_ID = "age-of-umbra-s12";
const ASOF = new Date("2026-09-14T12:00:00Z");

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

function rowsOf(payload: { components: Record<string, unknown>[] }) {
  return payload.components.map(
    (row) => (row as { components: { custom_id: string; label: string }[] }).components,
  );
}

beforeEach(async () => {
  globalThis.fetch = (async () =>
    Response.json({ id: "msg-1", channel_id: "chan-1" })) as typeof fetch;

  for (const table of [
    "publications",
    "poll_dates",
    "date_polls",
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
  for (const statement of seedStatements(campaign, session)) {
    await env.DB.prepare(statement).run();
  }
});

describe("where the button sits", () => {
  it("is in a second row, because the first is already five", async () => {
    const rows = rowsOf(renderAttendancePost({ target: await target(), rows: [], asOf: ASOF }));

    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveLength(5);
    expect(rows[1]?.map((c) => c.label)).toEqual(["Suggest another day"]);
  });

  it("leaves the five ids already on the first row exactly as they were", async () => {
    const [first] = rowsOf(renderAttendancePost({ target: await target(), rows: [], asOf: ASOF }));

    // A post minted before this PR has no Suggest button and must keep working.
    // Its other five ids are unchanged, which is the whole reason ids are
    // namespaced and versioned.
    expect(first?.map((c) => c.custom_id)).toEqual([
      encodeCustomId({ action: "attend", arg: "in", target: SESSION_ID }),
      encodeCustomId({ action: "attend", arg: "out", target: SESSION_ID }),
      encodeCustomId({ action: "attend", arg: "maybe", target: SESSION_ID }),
      encodeCustomId({ action: "attend", arg: "note", target: SESSION_ID }),
      encodeCustomId({ action: "attend", arg: "refresh", target: SESSION_ID }),
    ]);
  });

  it("decodes to the session and nothing else", () => {
    const id = (suggestButton(SESSION_ID) as { custom_id: string }).custom_id;
    expect(decodeCustomId(id)).toEqual({ action: "suggest", target: SESSION_ID });
  });

  it("is the identical id on the jeopardy notice", async () => {
    const notice = jeopardyNotice({
      target: await target(),
      rows: [],
      gmId: "gm-1",
      required: 3,
      asOf: ASOF,
    });

    // One mint and one handler for both, rather than two that drift.
    expect(rowsOf(notice)[0]?.[0]?.custom_id).toBe(
      (suggestButton(SESSION_ID) as { custom_id: string }).custom_id,
    );
  });
});

describe("the click", () => {
  it("opens the modal with the session already decided, and writes nothing", async () => {
    const res = await app.fetch(
      await discord.request({
        type: InteractionType.MESSAGE_COMPONENT,
        data: {
          custom_id: encodeCustomId({ action: "suggest", target: SESSION_ID }),
          component_type: 2,
        },
        member: { user: { id: "ada", username: "ada", global_name: null }, roles: [] },
        guild_id: "g",
        message: { id: "msg-1", channel_id: "chan-1" },
      }),
      discord.env(env),
    );

    const json = (await res.json()) as { type: number; data: { custom_id: string } };
    expect(json.type).toBe(InteractionResponseType.MODAL);
    expect(decodeCustomId(json.data.custom_id)).toMatchObject({
      action: "poll-open",
      target: SESSION_ID,
    });

    // Opening a modal is not opening a poll.
    expect(await db(env).select().from(schema.datePolls).all()).toEqual([]);
  });

  it("degrades to the retired-post response for a session that is gone", async () => {
    await env.DB.prepare("DELETE FROM sessions").run();

    const res = await app.fetch(
      await discord.request({
        type: InteractionType.MESSAGE_COMPONENT,
        data: {
          custom_id: encodeCustomId({ action: "suggest", target: SESSION_ID }),
          component_type: 2,
        },
        member: { user: { id: "ada", username: "ada", global_name: null }, roles: [] },
        guild_id: "g",
        message: { id: "msg-1", channel_id: "chan-1" },
      }),
      discord.env(env),
    );

    expect(((await res.json()) as { data: { content: string } }).data.content).toContain("retired");
  });
});
