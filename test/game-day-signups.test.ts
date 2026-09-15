import { env } from "cloudflare:test";
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { db, schema } from "../src/db/index.ts";
import { mintId } from "../src/db/ids.ts";
import {
  capacityOf,
  claimSeat,
  seated,
  seatsLeft,
  signupsForDay,
  waitlist,
  withdraw,
} from "../src/game-days/signups.ts";

/**
 * A second target for a signup, and the order people arrived in.
 *
 * The invariant under test is `CLAUDE.md`'s: a signup attaches to a campaign at
 * formation and to a game day, never to a session. Phase 2's CHECK is what
 * enforces it, and this phase writes the second kind of row for the first time —
 * so the first thing here is that the constraint still refuses the third.
 */
const START = 1_790_000_000;

async function day(over: Partial<typeof schema.gameDays.$inferInsert> = {}) {
  const id = mintId();
  await db(env)
    .insert(schema.gameDays)
    .values({
      id,
      kind: "single",
      gameId: "blades",
      state: "SEATING",
      startsAt: START,
      endsAt: START + 21_600,
      ...over,
    });
  return id;
}

async function people(count: number) {
  const ids = Array.from({ length: count }, (_, i) => `p${i}`);
  for (const id of ids) {
    await db(env)
      .insert(schema.users)
      .values({ discordId: id, username: id, feedToken: `t-${id}` })
      .onConflictDoNothing();
  }
  return ids;
}

function rowOf(gameDayId: string, userId: string) {
  return db(env)
    .select()
    .from(schema.signups)
    .where(
      and(
        eq(schema.signups.targetType, "game_day"),
        eq(schema.signups.targetId, gameDayId),
        eq(schema.signups.userId, userId),
      ),
    )
    .get();
}

beforeEach(async () => {
  for (const table of ["signups", "poll_dates", "date_polls", "game_days", "campaigns", "games", "users"]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  await db(env)
    .insert(schema.games)
    .values({ id: "blades", name: "Blades in the Dark", minPlayers: 3, maxPlayers: 4 });
});

describe("the constraint that says what a signup is for", () => {
  it("takes a game day", async () => {
    const id = await day();
    const [user] = await people(1);

    expect(await claimSeat(env, id, user!)).toMatchObject({ outcome: "seated" });
  });

  it("still refuses a session", async () => {
    await people(1);

    // The one invariant a rebuild of this table would have put at risk. There is
    // no rebuild: phase 2 wrote both allowed values into the CHECK on the day it
    // made the table, so this is the same constraint it has always been.
    await expect(
      env.DB.prepare(
        "INSERT INTO signups (target_type, target_id, user_id) VALUES ('session', 'age-of-umbra-s12', 'p0')",
      ).run(),
    ).rejects.toThrow();
  });

  it("leaves a forming campaign's signups exactly as they were", async () => {
    const [user] = await people(1);
    await db(env).insert(schema.campaigns).values({ id: "c1", name: "A Campaign", kind: "run" });
    await db(env)
      .insert(schema.signups)
      .values({ targetType: "campaign_forming", targetId: "c1", userId: user! });

    const id = await day();
    await claimSeat(env, id, user!);

    // Same person, two targets, two rows: the primary key is (type, id, user),
    // and a place at Saturday's table is not a place in a campaign.
    const forming = await db(env)
      .select()
      .from(schema.signups)
      .where(eq(schema.signups.targetType, "campaign_forming"))
      .all();
    expect(forming).toHaveLength(1);
    expect(forming[0]).toMatchObject({ state: "in", position: null });
  });
});

describe("capacity", () => {
  it("comes from the game when the day says nothing", async () => {
    expect(await capacityOf(env, await day())).toBe(4);
  });

  it("is the day's own number when it has one", async () => {
    // The evening the table only has five chairs — or, here, two.
    expect(await capacityOf(env, await day({ capacity: 2 }))).toBe(2);
  });

  it("is nothing at all for a multi day that names neither", async () => {
    expect(await capacityOf(env, await day({ kind: "multi", gameId: null }))).toBeNull();
  });
});

describe("claiming a place", () => {
  it("seats people while there are seats, then queues them", async () => {
    const id = await day({ capacity: 2 });
    const ids = await people(4);

    const outcomes = [];
    for (const user of ids) outcomes.push((await claimSeat(env, id, user)).outcome);

    expect(outcomes).toEqual(["seated", "seated", "waitlisted", "waitlisted"]);
  });

  it("gives arrival order to everybody, seated or not", async () => {
    const id = await day({ capacity: 2 });
    const ids = await people(3);
    for (const user of ids) await claimSeat(env, id, user);

    const rows = await signupsForDay(env, id);
    expect(rows.map((row) => [row.userId, row.state, row.position])).toEqual([
      ["p0", "in", 1],
      ["p1", "in", 2],
      ["p2", "waitlisted", 3],
    ]);
  });

  it("seats everybody when the day has no capacity to speak of", async () => {
    const id = await day({ kind: "multi", gameId: null });
    const ids = await people(9);
    for (const user of ids) await claimSeat(env, id, user);

    expect(seated(await signupsForDay(env, id))).toHaveLength(9);
    expect(seatsLeft(await capacityOf(env, id), await signupsForDay(env, id))).toBeNull();
  });

  it("collapses a second click onto the first", async () => {
    const id = await day({ capacity: 2 });
    const [user] = await people(1);
    await claimSeat(env, id, user!);

    const again = await claimSeat(env, id, user!);

    expect(again).toMatchObject({ outcome: "unchanged", state: "in", position: 1 });
    expect(await signupsForDay(env, id)).toHaveLength(1);
  });

  it("lets somebody who queued while seats were free take one", async () => {
    const id = await day({ capacity: 4 });
    const [user] = await people(1);
    await claimSeat(env, id, user!, { prefer: "waitlist" });

    const taken = await claimSeat(env, id, user!, { prefer: "seat" });

    // "I'll come if you need me" is what `prefer` is for, and the only other way
    // back out of it — Out, then Take a seat — costs the position they arrived
    // at. They keep it.
    expect(taken).toMatchObject({ outcome: "seated", state: "in", position: 1 });
  });

  it("still says nothing changed to a waitlister on a full day", async () => {
    const id = await day({ capacity: 1 });
    const ids = await people(2);
    await claimSeat(env, id, ids[0]!);
    await claimSeat(env, id, ids[1]!);

    const again = await claimSeat(env, id, ids[1]!, { prefer: "seat" });

    expect(again).toMatchObject({ outcome: "unchanged", state: "waitlisted", position: 2 });
  });

  it("does not queue anybody on a day with no capacity, however they ask", async () => {
    const id = await day({ kind: "multi", gameId: null });
    const [user] = await people(1);

    const asked = await claimSeat(env, id, user!, { prefer: "waitlist" });

    // A day with no capacity has no waitlist to promote from, so a waitlisted
    // row here is one nothing could ever promote and no click could change.
    expect(asked).toMatchObject({ outcome: "seated", state: "in" });
  });

  it("takes a character name a repeated click has finally filled in", async () => {
    const id = await day();
    const [user] = await people(1);
    await claimSeat(env, id, user!);

    await claimSeat(env, id, user!, { characterName: "Arquebus" });

    expect((await rowOf(id, user!))?.characterName).toBe("Arquebus");
  });

  it("does not let one seat go to two people who clicked at once", async () => {
    const id = await day({ capacity: 1 });
    const ids = await people(4);

    await Promise.all(ids.map((user) => claimSeat(env, id, user)));

    // The count, the position and the decision are all expressions inside one
    // INSERT, so the database serialises the four of them rather than four reads
    // all seeing an empty table.
    const rows = await signupsForDay(env, id);
    expect(seated(rows)).toHaveLength(1);
    expect(waitlist(rows)).toHaveLength(3);
    expect(new Set(rows.map((row) => row.position)).size).toBe(4);
  });
});

describe("what a day refuses", () => {
  it("says nothing doing for a day that has not opened seating", async () => {
    const id = await day({ state: "PROPOSED" });
    const [user] = await people(1);

    expect(await claimSeat(env, id, user!)).toMatchObject({ outcome: "not-seating" });
    expect(await signupsForDay(env, id)).toEqual([]);
  });

  it("says the same once the table is locked", async () => {
    const id = await day({ state: "LOCKED" });
    const [user] = await people(1);

    expect((await claimSeat(env, id, user!)).outcome).toBe("not-seating");
  });

  it("says so for a day that does not exist", async () => {
    const [user] = await people(1);
    expect((await claimSeat(env, "nothing-here", user!)).outcome).toBe("no-such-day");
  });
});

describe("giving the place back", () => {
  it("keeps the row and the arrival order", async () => {
    const id = await day({ capacity: 2 });
    const [user] = await people(1);
    await claimSeat(env, id, user!);

    expect(await withdraw(env, id, user!)).toBe("withdrawn");

    // "Claimed and withdrew" has to stay distinguishable from "never claimed".
    expect(await rowOf(id, user!)).toMatchObject({ state: "out", position: 1 });
    expect(await signupsForDay(env, id)).toEqual([]);
  });

  it("frees the seat for whoever comes next", async () => {
    const id = await day({ capacity: 1 });
    const ids = await people(3);
    await claimSeat(env, id, ids[0]!);
    await claimSeat(env, id, ids[1]!);
    await withdraw(env, id, ids[0]!);

    // Nothing is promoted here — that is p5/7's — but the seat is genuinely free
    // and the next arrival takes it.
    expect((await claimSeat(env, id, ids[2]!)).outcome).toBe("seated");
  });

  it("puts somebody who comes back at the back of the queue", async () => {
    const id = await day({ capacity: 4 });
    const ids = await people(3);
    for (const user of ids) await claimSeat(env, id, user);
    await withdraw(env, id, ids[0]!);

    const back = await claimSeat(env, id, ids[0]!);

    // They gave the place up. Coming back is a new arrival, not the restoration
    // of the one they had.
    expect(back).toMatchObject({ outcome: "seated", position: 4 });
  });

  it("is not an error for somebody who never claimed", async () => {
    const id = await day();
    const [user] = await people(1);
    expect(await withdraw(env, id, user!)).toBe("not-claimed");
  });

  it("is not an error twice", async () => {
    const id = await day();
    const [user] = await people(1);
    await claimSeat(env, id, user!);
    await withdraw(env, id, user!);

    expect(await withdraw(env, id, user!)).toBe("not-claimed");
  });
});

describe("counting the seats", () => {
  it("counts down as people arrive", async () => {
    const id = await day({ capacity: 3 });
    const ids = await people(2);
    for (const user of ids) await claimSeat(env, id, user);

    expect(seatsLeft(3, await signupsForDay(env, id))).toBe(1);
  });

  it("never goes below nothing", async () => {
    const id = await day({ capacity: 1 });
    const ids = await people(3);
    for (const user of ids) await claimSeat(env, id, user);

    expect(seatsLeft(1, await signupsForDay(env, id))).toBe(0);
  });
});
