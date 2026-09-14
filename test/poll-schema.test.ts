import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { db, schema } from "../src/db/index.ts";
import { ID_LENGTH, mintId } from "../src/db/ids.ts";
import { decodeCustomId, encodeCustomId } from "../src/discord/custom-id.ts";

/**
 * One poll, its dates, and the answers. The rule worth a test here is the one
 * SQLite enforces rather than a handler: at most one open poll per session.
 */
const SESSION = "age-of-umbra-s12";

async function seed() {
  await db(env)
    .insert(schema.campaigns)
    .values({ id: "age-of-umbra", name: "Age of Umbra", kind: "run", state: "RUNNING" });
  await db(env).insert(schema.sessions).values({
    id: SESSION,
    kind: "campaign_session",
    campaignId: "age-of-umbra",
    number: 12,
    startsAt: 1_790_000_000,
    endsAt: 1_790_014_400,
    location: "The Wreck",
  });
  await db(env)
    .insert(schema.users)
    .values({ discordId: "ada", username: "ada", feedToken: "t-ada" });
}

function poll(over: Partial<typeof schema.datePolls.$inferInsert> = {}) {
  return { id: mintId(), openedBy: "ada", campaignId: "age-of-umbra", ...over };
}

async function date(pollId: string, startsAt = 1_790_000_000) {
  const id = mintId();
  await db(env)
    .insert(schema.pollDates)
    .values({ id, pollId, startsAt, endsAt: startsAt + 14_400 });
  return id;
}

beforeEach(async () => {
  for (const table of [
    "poll_responses",
    "poll_dates",
    "date_polls",
    "sessions",
    "campaigns",
    "users",
  ]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  await seed();
});

describe("one open poll per session", () => {
  it("refuses a second open poll on the same session", async () => {
    await db(env).insert(schema.datePolls).values(poll({ targetSessionId: SESSION }));

    // Two /reschedule calls a second apart would otherwise each open a poll with
    // a live select, and nothing later in the phase could say which one counted.
    await expect(
      db(env).insert(schema.datePolls).values(poll({ targetSessionId: SESSION })),
    ).rejects.toThrow();
  });

  it("allows one once the first has closed", async () => {
    const first = poll({ targetSessionId: SESSION });
    await db(env).insert(schema.datePolls).values(first);
    await db(env)
      .update(schema.datePolls)
      .set({ status: "closed" })
      .where(eq(schema.datePolls.id, first.id as string));

    await db(env).insert(schema.datePolls).values(poll({ targetSessionId: SESSION }));

    expect(await db(env).select().from(schema.datePolls).all()).toHaveLength(2);
  });

  it("lets any number of untargeted polls be open at once", async () => {
    // These are not competing over anything, so the index skips nulls.
    await db(env).insert(schema.datePolls).values(poll());
    await db(env).insert(schema.datePolls).values(poll());
    await db(env).insert(schema.datePolls).values(poll());

    expect(await db(env).select().from(schema.datePolls).all()).toHaveLength(3);
  });

  it("takes the poll with the session it targets", async () => {
    await db(env).insert(schema.datePolls).values(poll({ targetSessionId: SESSION }));

    await env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(SESSION).run();

    // The cascade is written in the migration and D1 honours it; a poll about a
    // session that no longer exists is a post nobody can act on.
    expect(await db(env).select().from(schema.datePolls).all()).toEqual([]);
  });
});

describe("the dates and the answers", () => {
  it("holds one row per person per date", async () => {
    const p = poll();
    await db(env).insert(schema.datePolls).values(p);
    const first = await date(p.id as string);

    await db(env).insert(schema.pollResponses).values({ pollDateId: first, userId: "ada" });
    await expect(
      db(env).insert(schema.pollResponses).values({ pollDateId: first, userId: "ada" }),
    ).rejects.toThrow();
  });

  it("takes the answers with the poll", async () => {
    const p = poll();
    await db(env).insert(schema.datePolls).values(p);
    const first = await date(p.id as string);
    await db(env).insert(schema.pollResponses).values({ pollDateId: first, userId: "ada" });

    await env.DB.prepare("DELETE FROM date_polls").run();

    expect(await db(env).select().from(schema.pollDates).all()).toEqual([]);
    expect(await db(env).select().from(schema.pollResponses).all()).toEqual([]);
  });

  it("refuses a date that ends before it starts", async () => {
    const p = poll();
    await db(env).insert(schema.datePolls).values(p);

    await expect(
      db(env)
        .insert(schema.pollDates)
        .values({ id: mintId(), pollId: p.id as string, startsAt: 100, endsAt: 99 }),
    ).rejects.toThrow();
  });

  it("starts every date open and every poll open", async () => {
    const p = poll();
    await db(env).insert(schema.datePolls).values(p);
    const first = await date(p.id as string);

    expect(await db(env).select().from(schema.datePolls).get()).toMatchObject({
      status: "open",
      winRule: "best_available",
      winThreshold: null,
    });
    expect(
      await db(env).select().from(schema.pollDates).where(eq(schema.pollDates.id, first)).get(),
    ).toMatchObject({ outcome: "open" });
  });
});

describe("the ids", () => {
  it("mints distinct ones", () => {
    const minted = new Set(Array.from({ length: 500 }, () => mintId()));
    expect(minted.size).toBe(500);
    expect([...minted][0]).toHaveLength(ID_LENGTH);
  });

  it("fits inside a component id with room to spare", () => {
    const id = encodeCustomId({ action: "poll", arg: "select", target: mintId() });

    // encodeCustomId throws past 100 characters, so an id's length is a schema
    // decision. This is the test that is cheaper than the outage.
    expect(id.length).toBeLessThan(40);
    expect(decodeCustomId(id)).toMatchObject({ action: "poll", arg: "select" });
  });

  it("round-trips through the component id it will ride in", () => {
    const pollId = mintId();
    const encoded = encodeCustomId({ action: "poll", arg: "canon", target: pollId });
    expect(decodeCustomId(encoded)?.target).toBe(pollId);
  });
});
