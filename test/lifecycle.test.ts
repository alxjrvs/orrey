import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { db, schema } from "../src/db/index.ts";
import {
  IllegalTransition,
  isForming,
  transition,
  type CampaignState,
} from "../src/campaigns/lifecycle.ts";

/**
 * `FORMING → RUNNING ⇄ HIATUS → CONCLUDED`. What is worth testing is not that
 * the legal moves work, but that the illegal ones cannot be made — the map's two
 * absences are the whole of #22's "a closed roster never reopens on its own".
 */
const CAMPAIGN = "age-of-umbra";

const campaign = {
  id: CAMPAIGN,
  name: "Age of Umbra",
  kind: "run",
  discordChannelId: "100",
  discordRoleId: "200",
} as const;

async function seedCampaign(state: CampaignState): Promise<void> {
  await db(env).insert(schema.campaigns).values({ ...campaign, state });
}

async function seedSignup(userId: string, state: "in" | "waitlisted" | "out", character?: string) {
  await db(env)
    .insert(schema.users)
    .values({ discordId: userId, username: `user-${userId}`, feedToken: `tok-${userId}` })
    .onConflictDoNothing();
  await db(env)
    .insert(schema.signups)
    .values({
      targetType: "campaign_forming",
      targetId: CAMPAIGN,
      userId,
      state,
      ...(character === undefined ? {} : { characterName: character }),
    });
}

function stateOf() {
  return db(env)
    .select({ state: schema.campaigns.state })
    .from(schema.campaigns)
    .where(eq(schema.campaigns.id, CAMPAIGN))
    .get()
    .then((row) => row?.state);
}

function auditRows() {
  return db(env).select().from(schema.auditLog).all();
}

const ACTOR = "1001";

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM audit_log").run();
  await env.DB.prepare("DELETE FROM campaign_members").run();
  await env.DB.prepare("DELETE FROM signups").run();
  await env.DB.prepare("DELETE FROM sessions").run();
  await env.DB.prepare("DELETE FROM campaigns").run();
  await env.DB.prepare("DELETE FROM users").run();

  // Whoever asks is somebody Orrey already knows: the console upserts the user
  // on login, and `audit_log.actor_user_id` references `users` so the log can
  // never name someone who does not exist.
  await db(env)
    .insert(schema.users)
    .values({ discordId: ACTOR, username: "ada", feedToken: "tok-actor" });
});

describe("the campaign lifecycle", () => {
  const LEGAL: [CampaignState, CampaignState][] = [
    ["FORMING", "RUNNING"],
    ["RUNNING", "HIATUS"],
    ["HIATUS", "RUNNING"],
    ["RUNNING", "CONCLUDED"],
    ["HIATUS", "CONCLUDED"],
  ];

  const ILLEGAL: [CampaignState, CampaignState][] = [
    // A closed roster never reopens on its own.
    ["RUNNING", "FORMING"],
    ["HIATUS", "FORMING"],
    // CONCLUDED is terminal. A campaign that comes back is a new campaign.
    ["CONCLUDED", "RUNNING"],
    ["CONCLUDED", "HIATUS"],
    ["CONCLUDED", "FORMING"],
    // Forming is not paused; it has not started.
    ["FORMING", "HIATUS"],
    ["FORMING", "CONCLUDED"],
  ];

  it.each(LEGAL)("moves %s → %s", async (from, to) => {
    await seedCampaign(from);
    const result = await transition(env, CAMPAIGN, to, "1001");

    expect(result).toMatchObject({ from, to, changed: true });
    expect(await stateOf()).toBe(to);
  });

  it.each(ILLEGAL)("refuses %s → %s", async (from, to) => {
    await seedCampaign(from);

    await expect(transition(env, CAMPAIGN, to, "1001")).rejects.toBeInstanceOf(IllegalTransition);
    expect(await stateOf()).toBe(from);
    // A refused transition is not history. Nothing happened.
    expect(await auditRows()).toHaveLength(0);
  });

  it("treats a second click as nothing rather than as an error", async () => {
    await seedCampaign("RUNNING");
    const result = await transition(env, CAMPAIGN, "RUNNING", "1001");

    expect(result).toMatchObject({ changed: false });
    expect(await auditRows()).toHaveLength(0);
  });

  it("records who moved it, from where, to where", async () => {
    await seedCampaign("RUNNING");

    await transition(env, CAMPAIGN, "HIATUS", ACTOR);

    expect(await auditRows()).toMatchObject([
      {
        actorUserId: "1001",
        action: "campaign.transition",
        targetType: "campaign",
        targetId: CAMPAIGN,
        detail: { before: "RUNNING", after: "HIATUS" },
      },
    ]);
  });

  it("says the clock did it when the clock did it", async () => {
    await seedCampaign("RUNNING");
    await transition(env, CAMPAIGN, "HIATUS");

    expect((await auditRows())[0]).toMatchObject({ actorUserId: null });
  });

  it("refuses to attribute a move to somebody Orrey does not know", async () => {
    await seedCampaign("RUNNING");

    // Fail closed, atomically: the audit row and the state change are one batch,
    // so a log entry that could not be written is a transition that did not
    // happen. A campaign must not move with nobody's name on it.
    await expect(transition(env, CAMPAIGN, "HIATUS", "9999")).rejects.toThrow();
    expect(await stateOf()).toBe("RUNNING");
    expect(await auditRows()).toHaveLength(0);
  });

  it("refuses to move a campaign that does not exist", async () => {
    await expect(transition(env, "no-such-campaign", "RUNNING")).rejects.toThrow(/no campaign/);
  });
});

describe("starting a campaign closes its roster", () => {
  it("turns accepted signups into members, and leaves the queue queued", async () => {
    await seedCampaign("FORMING");
    await seedSignup("1001", "in", "Hollow");
    await seedSignup("1002", "in");
    await seedSignup("1003", "waitlisted");
    await seedSignup("1004", "out");

    const result = await transition(env, CAMPAIGN, "RUNNING", "1001");

    expect(result.membersAdded).toBe(2);
    const members = await db(env).select().from(schema.campaignMembers).all();
    expect(members.map((m) => m.userId).sort()).toEqual(["1001", "1002"]);
    // A waitlist is a queue, and starting the campaign is not letting it in.
    expect(members.map((m) => m.userId)).not.toContain("1003");
    expect(members.find((m) => m.userId === "1001")).toMatchObject({
      role: "player",
      characterName: "Hollow",
    });
  });

  it("leaves somebody already on the roster exactly as they were", async () => {
    await seedCampaign("FORMING");
    await seedSignup("1001", "in", "Hollow");
    // A GM put on the roster by hand before the campaign started.
    await db(env)
      .insert(schema.campaignMembers)
      .values({ campaignId: CAMPAIGN, userId: "1001", role: "gm", characterName: null });

    await transition(env, CAMPAIGN, "RUNNING", "1001");

    expect(await db(env).select().from(schema.campaignMembers).all()).toMatchObject([
      { userId: "1001", role: "gm", characterName: null },
    ]);
  });

  it("converts nothing on the transitions that are not a start", async () => {
    await seedCampaign("RUNNING");
    await seedSignup("1001", "in");

    // Stale signup rows from before it started must not walk back in through a
    // resume. The conversion belongs to FORMING → RUNNING and nothing else.
    await transition(env, CAMPAIGN, "HIATUS");
    const result = await transition(env, CAMPAIGN, "RUNNING");

    expect(result.membersAdded).toBe(0);
    expect(await db(env).select().from(schema.campaignMembers).all()).toHaveLength(0);
  });

  it("knows which campaigns are still taking signups", () => {
    expect(isForming({ state: "FORMING" })).toBe(true);
    for (const state of ["RUNNING", "HIATUS", "CONCLUDED"] as CampaignState[]) {
      expect(isForming({ state })).toBe(false);
    }
  });
});
