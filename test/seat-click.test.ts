import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { db, schema } from "../src/db/index.ts";
import { encodeCustomId } from "../src/discord/custom-id.ts";
import { InteractionResponseType, InteractionType, MessageFlags } from "../src/discord/types.ts";
import { createApp } from "../src/http/app.ts";
import { signupsForDay } from "../src/game-days/signups.ts";
import { fakeDiscord } from "./discord.ts";

/**
 * The click that takes the last seat.
 *
 * Type 7, answering the click's own message, and nothing else that touches a
 * posted message. The rest of the server sees a stale post until their next
 * Refresh, and that is the design rather than a gap: the alternative is editing
 * a message from the outside, which is the one thing send-only forbids.
 */
const discord = await fakeDiscord();
const app = createApp();
const START = Date.parse("2026-11-07T18:00:00Z") / 1000;
const DAY_ID = "day-1";

function member(id: string) {
  return { user: { id, username: `p${id}`, global_name: `Player ${id}` }, roles: [] };
}

async function click(arg: string, who: string, target = DAY_ID) {
  const res = await app.fetch(
    await discord.request({
      type: InteractionType.MESSAGE_COMPONENT,
      data: { custom_id: encodeCustomId({ action: "seat", arg, target }), component_type: 2 },
      member: member(who),
      message: { id: "msg-1", channel_id: "chan-1" },
    }),
    discord.env(env),
  );
  return (await res.json()) as {
    type: number;
    data: { content: string; components?: unknown[]; flags?: number };
  };
}

async function day(over: Partial<typeof schema.gameDays.$inferInsert> = {}) {
  await db(env)
    .insert(schema.gameDays)
    .values({
      id: DAY_ID,
      kind: "single",
      gameId: "blades",
      state: "SEATING",
      startsAt: START,
      endsAt: START + 18_000,
      venue: "The Wreck",
      discordChannelId: "chan-1",
      discordMessageId: "msg-1",
      ...over,
    });
}

function states() {
  return signupsForDay(env, DAY_ID).then((rows) =>
    rows.map((row) => [row.userId, row.state, row.position]),
  );
}

beforeEach(async () => {
  for (const table of ["signups", "game_days", "games", "users", "settings"]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  await db(env)
    .insert(schema.games)
    .values({ id: "blades", name: "Blades in the Dark", maxPlayers: 5 });
});

describe("taking a seat", () => {
  it("seats six people into five seats, in arrival order", async () => {
    await day();
    for (const who of ["1", "2", "3", "4", "5", "6"]) await click("in", who);

    // Overflow is not refused — the sixth becomes a waitlist place at the next
    // position, and the post they got back is what tells them.
    expect(await states()).toEqual([
      ["1", "in", 1],
      ["2", "in", 2],
      ["3", "in", 3],
      ["4", "in", 4],
      ["5", "in", 5],
      ["6", "waitlisted", 6],
    ]);
  });

  it("answers by rewriting the message it came from", async () => {
    await day();
    const answer = await click("in", "1");

    expect(answer.type).toBe(InteractionResponseType.UPDATE_MESSAGE);
    expect(answer.data.content).toContain("**Seated (1/5)**");
    expect(answer.data.content).toContain("Player 1");
  });

  it("tells the person who took the last seat that it was the last one", async () => {
    await day({ capacity: 2 });
    await click("in", "1");

    const answer = await click("in", "2");

    // The click that takes the last seat is the click that renders the full
    // post — which is the whole reason the write and the render share a lock.
    expect(answer.data.content).toContain("**Seated (2/2)**");
    expect(answer.data.content).toContain("Full.");
  });

  it("tells the sixth person they are on the waitlist", async () => {
    await day({ capacity: 1 });
    await click("in", "1");

    const answer = await click("in", "2");
    expect(answer.data.content).toContain("**Waitlist (1)** — Player 2");
  });

  it("does not take two seats for one person clicking twice", async () => {
    await day();
    await click("in", "1");
    await click("in", "1");

    expect(await states()).toEqual([["1", "in", 1]]);
  });

  it("puts somebody on the waitlist who asked for it while seats were free", async () => {
    await day();
    await click("wait", "1");

    // "I'll come if you need me" is a real answer, and a day with four empty
    // chairs should not overrule it.
    expect(await states()).toEqual([["1", "waitlisted", 1]]);
  });
});

describe("going out", () => {
  it("frees the seat and takes them off the post", async () => {
    await day();
    await click("in", "1");

    const answer = await click("out", "1");

    expect(await states()).toEqual([]);
    expect(answer.data.content).toContain("Nobody has taken a seat yet.");
  });

  it("takes the next free seat on the way back, not the old one", async () => {
    await day();
    for (const who of ["1", "2"]) await click("in", who);
    await click("out", "1");
    await click("in", "1");

    // They gave the place up; coming back is a new arrival.
    expect(await states()).toEqual([
      ["2", "in", 2],
      ["1", "in", 3],
    ]);
  });

  it("is not an error for somebody who never took one", async () => {
    await day();
    const answer = await click("out", "1");
    expect(answer.type).toBe(InteractionResponseType.UPDATE_MESSAGE);
  });
});

describe("refresh", () => {
  it("re-renders without writing anything", async () => {
    await day();
    await click("in", "1");

    const answer = await click("refresh", "2");

    expect(answer.type).toBe(InteractionResponseType.UPDATE_MESSAGE);
    expect(answer.data.content).toContain("**Seated (1/5)**");
    expect(await states()).toEqual([["1", "in", 1]]);
  });
});

describe("what it refuses", () => {
  it("says so rather than seating anybody once the table is locked", async () => {
    await day({ state: "LOCKED" });
    const answer = await click("in", "1");

    // Ephemeral, and the post is left exactly as it was: rewriting it would make
    // it look current when it is not, and Orrey cannot edit it back.
    expect(answer.type).toBe(InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE);
    expect(answer.data.flags! & MessageFlags.EPHEMERAL).toBeTruthy();
    expect(answer.data.content).toContain("settled");
    expect(await states()).toEqual([]);
  });

  it("says seating has not opened on a proposed day", async () => {
    await day({ state: "PROPOSED" });
    expect((await click("in", "1")).data.content).toContain("not opened yet");
  });

  it("still refreshes a day that has stopped taking seats", async () => {
    await day({ state: "LOCKED" });
    await db(env)
      .insert(schema.users)
      .values({ discordId: "1", username: "p1", feedToken: "t1" });
    await db(env)
      .insert(schema.signups)
      .values({ targetType: "game_day", targetId: DAY_ID, userId: "1", position: 1 });

    // Reading is never refused. Somebody looking at a locked day's post should
    // still be able to see who is at the table.
    const answer = await click("refresh", "2");
    expect(answer.type).toBe(InteractionResponseType.UPDATE_MESSAGE);
    expect(answer.data.content).toContain("**Seated (1/5)**");
  });

  it("degrades a click on a day that is gone to the retired-post response", async () => {
    const answer = await click("in", "1", "no-such-day");

    expect(answer.type).toBe(InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE);
    expect(answer.data.flags! & MessageFlags.EPHEMERAL).toBeTruthy();
  });

  it("degrades an argument it does not know", async () => {
    await day();
    const answer = await click("sideways", "1");
    expect(answer.type).toBe(InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE);
    expect(await states()).toEqual([]);
  });
});

describe("where the answer comes from", () => {
  it("reads D1, never the message it was sent", async () => {
    await day();
    await click("in", "1");

    // The interaction carries a `message`; nothing in the handler looks at it.
    // Proving it directly is awkward, so this proves the consequence: a post
    // whose content is a lie is ignored, and the answer is what D1 says.
    const res = await app.fetch(
      await discord.request({
        type: InteractionType.MESSAGE_COMPONENT,
        data: {
          custom_id: encodeCustomId({ action: "seat", arg: "refresh", target: DAY_ID }),
          component_type: 2,
        },
        member: member("2"),
        message: { id: "msg-1", channel_id: "chan-1", content: "**Seated (99/99)** — everybody" },
      }),
      discord.env(env),
    );
    const answer = (await res.json()) as { data: { content: string } };
    expect(answer.data.content).toContain("**Seated (1/5)**");
    // The lie by name rather than by digits: the footer carries an `As of` stamp
    // that is a live unix timestamp, so a bare "99" goes red whenever the clock
    // happens to contain those two characters — a failure that says nothing at
    // all about where the answer came from.
    expect(answer.data.content).not.toContain("(99/99)");
    expect(answer.data.content).not.toContain("everybody");
  });

  it("remembers whoever clicked, so the post can name them", async () => {
    await day();
    await click("in", "7");

    expect(
      await db(env).select().from(schema.users).where(eq(schema.users.discordId, "7")).get(),
    ).toMatchObject({ globalName: "Player 7" });
  });
});
