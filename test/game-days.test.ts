import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { db, schema } from "../src/db/index.ts";
import { mintId } from "../src/db/ids.ts";

/**
 * What a winning date produces. A separate table from the poll because it is a
 * separate idea — and separate from a session, because a game day does not
 * become a session's parent until phase 5.
 */
const START = 1_790_000_000;

async function day(over: Partial<typeof schema.gameDays.$inferInsert> = {}) {
  const id = mintId();
  await db(env)
    .insert(schema.gameDays)
    .values({ id, startsAt: START, endsAt: START + 21_600, ...over });
  return id;
}

async function pollWithDate() {
  const pollId = mintId();
  const dateId = mintId();
  await db(env).insert(schema.datePolls).values({ id: pollId });
  await db(env)
    .insert(schema.pollDates)
    .values({ id: dateId, pollId, startsAt: START, endsAt: START + 21_600 });
  return dateId;
}

function dateRow(id: string) {
  return db(env).select().from(schema.pollDates).where(eq(schema.pollDates.id, id)).get();
}

beforeEach(async () => {
  for (const table of [
    "poll_responses",
    "poll_dates",
    "date_polls",
    "game_days",
    "sessions",
    "campaigns",
  ]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
});

describe("a game day", () => {
  it("starts proposed, and single", async () => {
    const id = await day();

    expect(
      await db(env).select().from(schema.gameDays).where(eq(schema.gameDays.id, id)).get(),
    ).toMatchObject({ state: "PROPOSED", kind: "single", title: null });
  });

  it("can be several tables on one day", async () => {
    const id = await day({ kind: "multi", title: "Winter one-shots" });

    expect(
      await db(env).select().from(schema.gameDays).where(eq(schema.gameDays.id, id)).get(),
    ).toMatchObject({ kind: "multi", title: "Winter one-shots" });
  });
});

describe("the link from the date that won it", () => {
  it("is null until a date wins", async () => {
    expect(await dateRow(await pollWithDate())).toMatchObject({ gameDayId: null });
  });

  it("clears rather than taking the poll with it", async () => {
    const dateId = await pollWithDate();
    const dayId = await day();
    await db(env)
      .update(schema.pollDates)
      .set({ gameDayId: dayId, outcome: "won" })
      .where(eq(schema.pollDates.id, dateId));

    await env.DB.prepare("DELETE FROM game_days WHERE id = ?").bind(dayId).run();

    // The poll is still a true record of what people said. Losing that because a
    // day was called off would lose the only account of how the date was chosen.
    // This also pins the hand-corrected ON DELETE in 0009 — drizzle-kit drops it
    // on an added column, and without it this row would point at nothing.
    expect(await dateRow(dateId)).toMatchObject({ gameDayId: null, outcome: "won" });
  });
});

describe("what this PR does not do", () => {
  it("leaves sessions_parent_ck exactly as phase 1 wrote it", async () => {
    // A game day is not a session's parent yet. Widening this before anything
    // writes such a session would be widening it on faith.
    await expect(
      env.DB.prepare(
        "INSERT INTO sessions (id, kind, starts_at, ends_at) VALUES ('x', 'campaign_session', 1, 2)",
      ).run(),
    ).rejects.toThrow();

    await expect(
      env.DB.prepare(
        "INSERT INTO sessions (id, kind, starts_at, ends_at) VALUES ('y', 'one_off', 1, 2)",
      ).run(),
    ).resolves.toBeTruthy();
  });

  it("adds no column phase 4 reads nothing from", async () => {
    const columns = await env.DB.prepare("PRAGMA table_info(game_days)").all();
    expect((columns.results as { name: string }[]).map((c) => c.name).sort()).toEqual([
      "capacity",
      "created_at",
      "discord_channel_id",
      "discord_message_id",
      "ends_at",
      "game_id",
      "host_user_id",
      "id",
      "kind",
      "starts_at",
      "state",
      "thread_id",
      "title",
      "updated_at",
      "venue",
      // Added by p7/6, which records how deep the queue was when the table
      // settled. The list is exact on purpose — a column arriving unannounced
      // is the thing this test is here to notice — so a later phase adding one
      // says so here.
      "waitlist_at_lock",
    ]);
  });
});
