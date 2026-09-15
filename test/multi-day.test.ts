import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { db, schema } from "../src/db/index.ts";
import { encodeCustomId } from "../src/discord/custom-id.ts";
import { InteractionResponseType, InteractionType } from "../src/discord/types.ts";
import { createApp } from "../src/http/app.ts";
import { renderSignupPost, seatButtons } from "../src/game-days/render.ts";
import { capacityOf, signupsForDay } from "../src/game-days/signups.ts";
import { promoteFromWaitlist } from "../src/game-days/promote.ts";
import { attendanceRows } from "../src/attendance/rows.ts";
import { fakeDiscord } from "./discord.ts";

/**
 * Coming to the day?
 *
 * A multi day is a hangout, so stage two asks one question. What is worth
 * testing is that it is one renderer with two variants rather than two
 * renderers: the difference is a capacity and a couple of words, and everything
 * above the render — the seat write, the promotion, the roster handoff — is the
 * single day's code, untouched.
 */
const discord = await fakeDiscord();
const app = createApp();
const START = Date.parse("2026-11-07T12:00:00Z") / 1000;
const DAY_ID = "day-1";

async function day(over: Partial<typeof schema.gameDays.$inferInsert> = {}) {
  await db(env)
    .insert(schema.gameDays)
    .values({
      id: DAY_ID,
      kind: "multi",
      gameId: null,
      title: "November Games Day",
      state: "SEATING",
      startsAt: START,
      endsAt: START + 8 * 3600,
      venue: "The Wreck",
      discordChannelId: "chan-1",
      discordMessageId: "msg-1",
      ...over,
    });
}

async function click(arg: string, who: string) {
  const res = await app.fetch(
    await discord.request({
      type: InteractionType.MESSAGE_COMPONENT,
      data: {
        custom_id: encodeCustomId({ action: "seat", arg, target: DAY_ID }),
        component_type: 2,
      },
      member: { user: { id: who, username: who, global_name: `Player ${who}` }, roles: [] },
      message: { id: "msg-1", channel_id: "chan-1" },
    }),
    discord.env(env),
  );
  return (await res.json()) as { type: number; data: { content: string; components?: unknown[] } };
}

async function view(asOf = new Date(START * 1000)) {
  const row = await db(env)
    .select({ day: schema.gameDays, game: schema.games })
    .from(schema.gameDays)
    .leftJoin(schema.games, eq(schema.gameDays.gameId, schema.games.id))
    .where(eq(schema.gameDays.id, DAY_ID))
    .get();
  return {
    day: row!.day,
    game: row!.game,
    signups: await signupsForDay(env, DAY_ID),
    capacity: await capacityOf(env, DAY_ID),
    asOf,
  };
}

function states() {
  return signupsForDay(env, DAY_ID).then((rows) =>
    rows.map((row) => [row.userId, row.state]),
  );
}

beforeEach(async () => {
  for (const table of ["attendance", "signups", "sessions", "game_days", "games", "users", "settings"]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  await db(env)
    .insert(schema.games)
    .values({ id: "blades", name: "Blades in the Dark", minPlayers: 3, maxPlayers: 4 });
});

describe("the question it asks", () => {
  it("is whether you are coming, not whether there is a seat", async () => {
    await day();
    for (const who of ["1", "2"]) await click("in", who);

    const { content } = renderSignupPost(await view());
    expect(content).toContain("**Coming (2)**");
    expect(content).not.toContain("Seated");
    expect(content).toContain("Everybody welcome");
  });

  it("invents no seat count when nobody set one", async () => {
    await day();
    await click("in", "1");

    // A day that has not been given a limit has not asked the question the
    // count answers.
    expect(renderSignupPost(await view()).content).not.toMatch(/\(\d+\/\d+\)/);
  });

  it("counts against a capacity when there is one", async () => {
    await day({ capacity: 8 });
    await click("in", "1");

    expect(renderSignupPost(await view()).content).toContain("**Coming (1/8)**");
    expect(renderSignupPost(await view()).content).toContain("7 places left.");
  });

  it("says nobody has said yet rather than nobody has taken a seat", async () => {
    await day();
    expect(renderSignupPost(await view()).content).toContain("Nobody has said yet.");
  });
});

describe("the buttons", () => {
  it("offer Coming rather than Take a seat", async () => {
    const row = seatButtons(DAY_ID, "multi", null) as { components: { label: string }[] };
    expect(row.components.map((button) => button.label)).toEqual(["Coming", "Out", "Refresh"]);
  });

  it("leave out Waitlist when there is no limit to be past", () => {
    const row = seatButtons(DAY_ID, "multi", null) as { components: { label: string }[] };
    // A button that always lands somebody in a waitlist of one is a button that
    // lies about what the day is.
    expect(row.components.map((button) => button.label)).not.toContain("Waitlist");
  });

  it("bring it back when the day has a capacity", () => {
    const row = seatButtons(DAY_ID, "multi", 8) as { components: { label: string }[] };
    expect(row.components.map((button) => button.label)).toEqual([
      "Coming",
      "Waitlist",
      "Out",
      "Refresh",
    ]);
  });

  it("carry the same ids as a single day's", () => {
    const multi = seatButtons(DAY_ID, "multi", 8) as { components: { custom_id: string }[] };
    const single = seatButtons(DAY_ID, "single", 8) as { components: { custom_id: string }[] };

    // Coming and Take a seat are the same click. A second argument meaning what
    // the first one means is a second handler branch to keep in step for nothing.
    expect(multi.components.map((b) => b.custom_id)).toEqual(
      single.components.map((b) => b.custom_id),
    );
  });
});

describe("the seat write, unchanged", () => {
  it("never waitlists anybody on a day with no capacity", async () => {
    await day();
    for (const who of ["1", "2", "3", "4", "5", "6", "7", "8", "9"]) await click("in", who);

    // A null capacity means unbounded, which `claimSeat` already knew. This
    // falls out of `p5/3` rather than being written again.
    expect((await states()).every(([, state]) => state === "in")).toBe(true);
  });

  it("seats a replayed Waitlist click on a day with no limit", async () => {
    await day();

    // The button is gone from the render, but a custom_id is a string the
    // client sends — `o1:seat:wait:<dayId>` is copyable off any capped day's
    // post. Withholding the button in the renderer alone would leave the write
    // able to put somebody in a waitlist nothing can ever promote them out of.
    const answer = await click("wait", "1");

    expect(await states()).toEqual([["1", "in"]]);
    expect(answer.data.content).not.toContain("Waitlist");
  });

  it("waitlists past a capacity exactly as a single day does", async () => {
    await day({ capacity: 2 });
    for (const who of ["1", "2", "3"]) await click("in", who);

    expect(await states()).toEqual([
      ["1", "in"],
      ["2", "in"],
      ["3", "waitlisted"],
    ]);
  });

  it("promotes the head of the queue the same way", async () => {
    await day({ capacity: 1 });
    await click("in", "1");
    await click("in", "2");

    await click("out", "1");

    expect(await states()).toEqual([["2", "in"]]);
  });

  it("answers by rewriting the message it came from", async () => {
    await day();
    const answer = await click("in", "1");

    expect(answer.type).toBe(InteractionResponseType.UPDATE_MESSAGE);
    expect(answer.data.content).toContain("**Coming (1)**");
  });
});

describe("the roster handoff, unchanged", () => {
  it("is the same code path a single day uses", async () => {
    await day();
    for (const who of ["1", "2"]) await click("in", who);
    await db(env)
      .insert(schema.sessions)
      .values({
        id: "gd-day-1",
        kind: "one_off",
        gameDayId: DAY_ID,
        startsAt: START,
        endsAt: START + 8 * 3600,
      });

    expect((await attendanceRows(env, "gd-day-1")).map((row) => row.userId)).toEqual(["1", "2"]);
  });

  it("leaves the waitlist off it, capacity or not", async () => {
    await day({ capacity: 1 });
    for (const who of ["1", "2"]) await click("in", who);
    await db(env)
      .insert(schema.sessions)
      .values({
        id: "gd-day-1",
        kind: "one_off",
        gameDayId: DAY_ID,
        startsAt: START,
        endsAt: START + 8 * 3600,
      });

    expect((await attendanceRows(env, "gd-day-1")).map((row) => row.userId)).toEqual(["1"]);
  });
});

describe("what is absent", () => {
  it("has no notion of a table", async () => {
    await day({ capacity: 4 });
    for (const who of ["1", "2"]) await click("in", who);

    // Tables form on the day. What gets recorded is recorded afterwards, and
    // that is `p5/13` — one optional column, not a schema.
    const { content } = renderSignupPost(await view());
    expect(content).not.toContain("Table 1");
    expect(await promoteFromWaitlist(env, DAY_ID)).toEqual([]);
  });
});
