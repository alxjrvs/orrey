import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { db, schema } from "../src/db/index.ts";
import { singleNamesGame } from "../src/db/schema.ts";
import { mintId } from "../src/db/ids.ts";

/**
 * What a game day is, beyond its date. Phase 4 minted the row because a winning
 * poll date had to go somewhere; this is the rest of it.
 */
const START = 1_790_000_000;

async function day(over: Partial<typeof schema.gameDays.$inferInsert> = {}) {
  const id = mintId();
  await db(env)
    .insert(schema.gameDays)
    .values({ id, startsAt: START, endsAt: START + 21_600, ...over });
  return id;
}

function row(id: string) {
  return db(env).select().from(schema.gameDays).where(eq(schema.gameDays.id, id)).get();
}

beforeEach(async () => {
  for (const table of ["poll_dates", "date_polls", "game_days", "games", "users"]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  await db(env)
    .insert(schema.games)
    .values({ id: "blades", name: "Blades in the Dark", minPlayers: 3, maxPlayers: 6 });
  await db(env)
    .insert(schema.users)
    .values({ discordId: "host-1", username: "host", feedToken: "t-host" });
});

describe("a day that names a game", () => {
  it("accepts a single day with one", async () => {
    const id = await day({ kind: "single", gameId: "blades" });
    expect(singleNamesGame((await row(id))!)).toBe(true);
  });

  it("says a single day without one is wrong", () => {
    // The rule lives in code rather than in a CHECK, and the migration says why:
    // adding a constraint means a rebuild, and a rebuild of `game_days` blanks
    // every `poll_dates.game_day_id` phase 4 wrote.
    expect(singleNamesGame({ kind: "single", gameId: null })).toBe(false);
  });

  it("does not ask a multi day to name one", () => {
    expect(singleNamesGame({ kind: "multi", gameId: null })).toBe(true);
  });
});

describe("the columns", () => {
  it("takes a venue, a host and a capacity", async () => {
    const id = await day({
      kind: "single",
      gameId: "blades",
      venue: "The Wreck, back room",
      hostUserId: "host-1",
      capacity: 5,
    });

    expect(await row(id)).toMatchObject({
      venue: "The Wreck, back room",
      hostUserId: "host-1",
      // The override for the evening the table only has five chairs.
      capacity: 5,
    });
  });

  it("leaves capacity null so a single day can take the game's", async () => {
    expect(await row(await day({ kind: "single", gameId: "blades" }))).toMatchObject({
      capacity: null,
    });
  });

  it("starts PROPOSED, which is the state Orrey does not publish", async () => {
    expect(await row(await day({ kind: "multi" }))).toMatchObject({ state: "PROPOSED" });
  });
});

describe("what deleting something else does to it", () => {
  it("forgets the host rather than refusing the deletion", async () => {
    const id = await day({ kind: "multi", hostUserId: "host-1" });

    await env.DB.prepare("DELETE FROM users WHERE discord_id = ?").bind("host-1").run();

    // The privacy route deletes a user on request. A foreign key that refused
    // would turn a term of service into a 500.
    expect(await row(id)).toMatchObject({ hostUserId: null });
  });

  it("keeps a day whose game left the library", async () => {
    const id = await day({ kind: "single", gameId: "blades" });

    await env.DB.prepare("DELETE FROM games WHERE id = ?").bind("blades").run();

    expect(await row(id)).toMatchObject({ gameId: null });
  });
});

describe("what phase 4 wrote", () => {
  it("still points at its winning date", async () => {
    const dayId = await day({ kind: "single", gameId: "blades" });
    const pollId = mintId();
    const dateId = mintId();
    await db(env).insert(schema.datePolls).values({ id: pollId });
    await db(env).insert(schema.pollDates).values({
      id: dateId,
      pollId,
      startsAt: START,
      endsAt: START + 21_600,
      gameDayId: dayId,
      outcome: "won",
    });

    // This migration adds columns rather than rebuilding, and that is the whole
    // point: a rebuild would have fired the SET NULL and blanked this link.
    expect(
      await db(env).select().from(schema.pollDates).where(eq(schema.pollDates.id, dateId)).get(),
    ).toMatchObject({ gameDayId: dayId, outcome: "won" });
  });
});
