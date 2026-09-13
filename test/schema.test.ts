import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { db, schema } from "../src/db/index.ts";

/**
 * The phase-1 domain tables. What is worth a test here is not that drizzle can
 * write a row, but the two rules the schema itself enforces — the parent a
 * session's kind promises, and one Google event per session.
 */
const campaign = {
  id: "age-of-umbra",
  name: "Age of Umbra",
  kind: "run",
  discordChannelId: "100",
  discordRoleId: "200",
  state: "RUNNING",
} as const;

const session = {
  id: "age-of-umbra-s12",
  kind: "campaign_session",
  campaignId: campaign.id,
  number: 12,
  startsAt: 1_790_000_000,
  endsAt: 1_790_014_400,
  location: "The Wreck",
} as const;

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM sessions").run();
  await env.DB.prepare("DELETE FROM campaigns").run();
  await env.DB.prepare("DELETE FROM users").run();
});

describe("the phase-1 tables", () => {
  it("stores one session of one running campaign", async () => {
    const d = db(env);
    await d.insert(schema.campaigns).values(campaign);
    await d.insert(schema.sessions).values(session);

    const row = await d.select().from(schema.sessions).get();
    expect(row).toMatchObject({ campaignId: "age-of-umbra", number: 12, state: "SCHEDULED" });
    // Nothing has been projected yet: both ids are the projector's to fill in.
    expect(row?.discordEventId).toBeNull();
    expect(row?.discordMessageId).toBeNull();
  });

  it("refuses a campaign session with no campaign", async () => {
    await expect(
      db(env).insert(schema.sessions).values({ ...session, campaignId: null }),
    ).rejects.toThrow();
  });

  it("refuses a one-off that hangs off a campaign", async () => {
    await db(env).insert(schema.campaigns).values(campaign);
    await expect(
      db(env).insert(schema.sessions).values({ ...session, kind: "one_off" }),
    ).rejects.toThrow();
  });

  it("accepts a one-off with no parent — game days give it one in phase 5", async () => {
    await db(env)
      .insert(schema.sessions)
      .values({ ...session, kind: "one_off", campaignId: null, number: null });

    expect(await db(env).select().from(schema.sessions).get()).toMatchObject({ kind: "one_off" });
  });

  it("allows one Google event per session and no more", async () => {
    const d = db(env);
    await d.insert(schema.campaigns).values(campaign);
    await d.insert(schema.sessions).values(session);
    await d.insert(schema.sessions).values({ ...session, id: "age-of-umbra-s13" });

    await d
      .insert(schema.calendarLinks)
      .values({ sessionId: session.id, gcalEventId: "aabbccdd" });

    await expect(
      d.insert(schema.calendarLinks).values({ sessionId: "age-of-umbra-s13", gcalEventId: "aabbccdd" }),
    ).rejects.toThrow();
  });

  it("keeps one attendance row per person per session", async () => {
    const d = db(env);
    await d.insert(schema.campaigns).values(campaign);
    await d.insert(schema.sessions).values(session);
    await d
      .insert(schema.users)
      .values({ discordId: "1001", username: "ada", feedToken: "tok" });

    const row = { sessionId: session.id, userId: "1001" };
    await d.insert(schema.attendance).values({ ...row, intent: "maybe" });
    await d
      .insert(schema.attendance)
      .values({ ...row, intent: "in" })
      .onConflictDoUpdate({
        target: [schema.attendance.sessionId, schema.attendance.userId],
        set: { intent: "in" },
      });

    const rows = await d.select().from(schema.attendance).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ intent: "in", attended: null, note: null });
  });
});
