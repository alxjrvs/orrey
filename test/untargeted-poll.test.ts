import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db, schema } from "../src/db/index.ts";
import { SETTING_KEYS, setSetting } from "../src/db/settings.ts";
import { createApp } from "../src/http/app.ts";
import { InteractionType } from "../src/discord/types.ts";
import { fakeDiscord } from "./discord.ts";
import { openPollFromConsole } from "../src/console/polls.ts";
import { FIND_A_DAY } from "../src/discord/interactions.ts";

/**
 * A poll with no target — date-finding for the whole server. The rule under test
 * throughout is that the command surface stays at four: this is a console page
 * and a synthetic autocomplete choice, never a fifth command.
 */
const realFetch = globalThis.fetch;
const discord = await fakeDiscord();
const app = createApp();
const ORGANISER_ROLE = "role-organiser";

const DATES = "2026-10-01 19:00\n2026-10-08 19:00";

async function game(id: string, name: string, minPlayers: number | null) {
  await db(env).insert(schema.games).values({ id, name, minPlayers, maxPlayers: 6 });
}

async function person(id: string) {
  await db(env)
    .insert(schema.users)
    .values({ discordId: id, username: id, feedToken: `t-${id}` })
    .onConflictDoNothing();
}

function polls() {
  return db(env).select().from(schema.datePolls).all();
}

function autocomplete(roles: string[]) {
  return discord.request({
    type: InteractionType.APPLICATION_COMMAND_AUTOCOMPLETE,
    data: { name: "reschedule", options: [{ name: "event", value: "", focused: true }] },
    member: { user: { id: "ada", username: "ada", global_name: null }, roles },
    guild_id: "g",
  });
}

beforeEach(async () => {
  globalThis.fetch = (async () =>
    Response.json({ id: "msg-1", channel_id: "chan-1" })) as typeof fetch;

  for (const table of [
    "publications",
    "poll_responses",
    "poll_dates",
    "date_polls",
    "game_days",
    "campaign_members",
    "jobs",
    "sessions",
    "campaigns",
    "games",
    "users",
    "settings",
  ]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  await setSetting(env, SETTING_KEYS.guildId, "g1");
  await setSetting(env, SETTING_KEYS.timezone, "Europe/London");
  await setSetting(env, SETTING_KEYS.schedulingChannelId, "chan-scheduling");
  await setSetting(env, SETTING_KEYS.organiserRoleId, ORGANISER_ROLE);
  await person("ada");
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("what an untargeted poll must say", () => {
  it("is refused by name without a game", async () => {
    expect(
      await openPollFromConsole(env, { gameDayKind: "single", dates: DATES }, "ada"),
    ).toMatchObject({ ok: false, error: "which game is it for?", status: 400 });
    expect(await polls()).toEqual([]);
  });

  it("is refused by name without a kind", async () => {
    await game("blades", "Blades in the Dark", 3);
    expect(
      await openPollFromConsole(env, { gameId: "blades", dates: DATES }, "ada"),
    ).toMatchObject({ ok: false, error: "one table or several?", status: 400 });
  });

  it("is refused without dates", async () => {
    await game("blades", "Blades in the Dark", 3);
    expect(
      await openPollFromConsole(env, { gameId: "blades", gameDayKind: "single" }, "ada"),
    ).toMatchObject({ ok: false, status: 400 });
  });
});

describe("the win rule it gets", () => {
  it("takes the threshold from the game row, not from a constant", async () => {
    await game("blades", "Blades in the Dark", 3);

    await openPollFromConsole(
      env,
      { gameId: "blades", gameDayKind: "single", dates: DATES },
      "ada",
    );

    // That number is already the answer to "how many does it take"; having it in
    // two places is having it wrong in one.
    expect((await polls())[0]).toMatchObject({ winRule: "min_players", winThreshold: 3 });
  });

  it("falls back rather than inventing a threshold nobody agreed to", async () => {
    await game("freeform", "Something Freeform", null);

    await openPollFromConsole(
      env,
      { gameId: "freeform", gameDayKind: "multi", dates: DATES },
      "ada",
    );

    expect((await polls())[0]).toMatchObject({ winRule: "best_available", winThreshold: null });
  });

  it("lets an explicit rule override the default", async () => {
    await game("blades", "Blades in the Dark", 3);

    await openPollFromConsole(
      env,
      {
        gameId: "blades",
        gameDayKind: "single",
        dates: DATES,
        winRule: "organiser_picks",
      },
      "ada",
    );

    expect((await polls())[0]).toMatchObject({ winRule: "organiser_picks" });
  });

  it("refuses a rule Orrey does not have", async () => {
    await game("blades", "Blades in the Dark", 3);

    expect(
      await openPollFromConsole(
        env,
        { gameId: "blades", gameDayKind: "single", dates: DATES, winRule: "vibes" },
        "ada",
      ),
    ).toMatchObject({ ok: false, status: 400 });
    expect(await polls()).toEqual([]);
  });
});

describe("several at once", () => {
  it("does not refuse a second untargeted poll", async () => {
    await game("blades", "Blades in the Dark", 3);
    const body = { gameId: "blades", gameDayKind: "single" as const, dates: DATES };

    expect(await openPollFromConsole(env, body, "ada")).toMatchObject({ ok: true });
    expect(await openPollFromConsole(env, body, "ada")).toMatchObject({ ok: true });

    // The partial unique index is scoped to non-null targets. A server can have
    // several of these open, and often will.
    expect(await polls()).toHaveLength(2);
  });

  it("puts them in the scheduling channel", async () => {
    await game("blades", "Blades in the Dark", 3);
    await openPollFromConsole(
      env,
      { gameId: "blades", gameDayKind: "single", dates: DATES },
      "ada",
    );

    expect((await polls())[0]).toMatchObject({ discordChannelId: "chan-scheduling" });
  });
});

describe("the two ways in", () => {
  it("keeps the console route behind the same gate as everything else", async () => {
    const res = await app.fetch(
      new Request("https://orrey.test/api/polls", {
        method: "POST",
        body: JSON.stringify({ gameId: "blades", gameDayKind: "single", dates: DATES }),
      }),
      discord.env(env),
    );

    expect(res.status).toBe(401);
    expect(await polls()).toEqual([]);
  });

  it("offers the synthetic choice only to an organiser", async () => {
    const without = await app.fetch(await autocomplete([]), discord.env(env));
    const withRole = await app.fetch(await autocomplete([ORGANISER_ROLE]), discord.env(env));

    const values = async (res: Response) =>
      ((await res.json()) as { data: { choices: { value: string }[] } }).data.choices.map(
        (choice) => choice.value,
      );

    expect(await values(without)).not.toContain(FIND_A_DAY);
    expect(await values(withRole)).toContain(FIND_A_DAY);
  });

  it("checks the role again when somebody types the sentinel", async () => {
    const res = await app.fetch(
      await discord.request({
        type: InteractionType.APPLICATION_COMMAND,
        data: { name: "reschedule", options: [{ name: "event", value: FIND_A_DAY }] },
        member: { user: { id: "ada", username: "ada", global_name: null }, roles: [] },
        guild_id: "g",
      }),
      discord.env(env),
    );

    // The suggestion is a convenience, not the access check — a person can type
    // any value they like.
    expect(((await res.json()) as { data: { content: string } }).data.content).toContain(
      "Only an organiser",
    );
  });

  it("sends an organiser to the console page rather than growing a fifth command", async () => {
    const res = await app.fetch(
      await discord.request({
        type: InteractionType.APPLICATION_COMMAND,
        data: { name: "reschedule", options: [{ name: "event", value: FIND_A_DAY }] },
        member: { user: { id: "ada", username: "ada", global_name: null }, roles: [ORGANISER_ROLE] },
        guild_id: "g",
      }),
      discord.env(env),
    );

    // If opening a poll here seems to want its own command, that is the console
    // needing a page — which is what it got.
    expect(((await res.json()) as { data: { content: string } }).data.content).toContain("console");
  });
});
