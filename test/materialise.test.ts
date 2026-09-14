import { env } from "cloudflare:test";
import { asc, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { db, schema } from "../src/db/index.ts";
import { SETTING_KEYS, setSetting } from "../src/db/settings.ts";
import { materialiseHorizon } from "../src/campaigns/materialise.ts";
import { handleScheduled } from "../src/cron/scheduled.ts";

/**
 * The hourly tick. What is worth testing is the three things it must not do:
 * make a session twice, overwrite one somebody moved, or make one for a campaign
 * that is not running.
 */
const CAMPAIGN = "age-of-umbra";
const NOW = new Date("2026-09-14T12:00:00Z");

const campaign = {
  id: CAMPAIGN,
  name: "Age of Umbra",
  kind: "run",
  discordChannelId: "chan-1",
  discordRoleId: "role-1",
  state: "RUNNING",
  // A fortnightly 19:00 game, anchored two and a half years back.
  recurrenceAnchor: Math.floor(Date.parse("2024-01-06T19:00:00Z") / 1000),
  intervalWeeks: 2,
  firstSessionNumber: 1,
} as const;

function sessions() {
  return db(env).select().from(schema.sessions).orderBy(asc(schema.sessions.startsAt)).all();
}

function jobs() {
  return db(env).select().from(schema.jobs).orderBy(asc(schema.jobs.id)).all();
}

beforeEach(async () => {
  for (const table of ["jobs", "attendance", "sessions", "campaigns", "games", "settings"]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  await setSetting(env, SETTING_KEYS.timezone, "Europe/London");
  await setSetting(env, SETTING_KEYS.horizonSessions, 3);
  await setSetting(env, SETTING_KEYS.attendanceLeadDays, 10);
});

describe("materialising the horizon", () => {
  it("makes the next few sessions of a running campaign", async () => {
    await db(env).insert(schema.campaigns).values(campaign);

    const made = await materialiseHorizon(env, NOW);

    expect(made).toHaveLength(3);
    const rows = await sessions();
    expect(rows).toHaveLength(3);
    // Numbered from the anchor, not from one.
    const first = rows[0]!.number ?? 0;
    expect(first).toBeGreaterThan(60);
    expect(rows.map((row) => row.number)).toEqual([first, first + 1, first + 2]);
    // The id is derived from the number, which is what makes a re-run free.
    expect(rows[0]!.id).toBe(`${CAMPAIGN}-s${first}`);
    expect(rows.every((row) => row.startsAt >= NOW.getTime() / 1000)).toBe(true);
  });

  it("makes nothing the second time, and nothing the tenth", async () => {
    await db(env).insert(schema.campaigns).values(campaign);
    await materialiseHorizon(env, NOW);

    expect(await materialiseHorizon(env, NOW)).toEqual([]);
    expect(await materialiseHorizon(env, NOW)).toEqual([]);
    expect(await sessions()).toHaveLength(3);
  });

  it("never moves a session somebody else moved", async () => {
    await db(env).insert(schema.campaigns).values(campaign);
    const [first] = await materialiseHorizon(env, NOW);

    // A date poll, or a GM in the console, moves it a day later.
    const moved = first!.startsAt + 86_400;
    await db(env)
      .update(schema.sessions)
      .set({ startsAt: moved })
      .where(eq(schema.sessions.id, first!.sessionId));

    await materialiseHorizon(env, NOW);

    const row = await db(env)
      .select()
      .from(schema.sessions)
      .where(eq(schema.sessions.id, first!.sessionId))
      .get();
    // An hourly job that reverted this would undo somebody's decision every hour.
    expect(row?.startsAt).toBe(moved);
    expect(await sessions()).toHaveLength(3);
  });

  it("leaves alone every campaign that is not running", async () => {
    for (const state of ["FORMING", "HIATUS", "CONCLUDED"] as const) {
      await env.DB.prepare("DELETE FROM sessions").run();
      await env.DB.prepare("DELETE FROM campaigns").run();
      await db(env).insert(schema.campaigns).values({ ...campaign, state });

      expect(await materialiseHorizon(env, NOW)).toEqual([]);
      expect(await sessions()).toEqual([]);
    }
  });

  it("resumes from the anchor after a hiatus, with no memory of the pause", async () => {
    await db(env).insert(schema.campaigns).values({ ...campaign, state: "HIATUS" });
    expect(await materialiseHorizon(env, NOW)).toEqual([]);

    await db(env)
      .update(schema.campaigns)
      .set({ state: "RUNNING" })
      .where(eq(schema.campaigns.id, CAMPAIGN));

    const made = await materialiseHorizon(env, NOW);
    // The anchor never moved, so resuming needs nothing remembered about when it
    // stopped: the cadence lands where it always would have.
    expect(made).toHaveLength(3);
  });

  it("skips a campaign with no cadence rather than throwing past the others", async () => {
    await db(env)
      .insert(schema.campaigns)
      .values({ ...campaign, recurrenceAnchor: null, intervalWeeks: null });
    await db(env)
      .insert(schema.campaigns)
      .values({ ...campaign, id: "other", name: "Other" });

    const made = await materialiseHorizon(env, NOW);

    expect(made.every((row) => row.campaignId === "other")).toBe(true);
    expect(made).toHaveLength(3);
  });

  it("stops at max_sessions without concluding the campaign", async () => {
    await db(env)
      .insert(schema.campaigns)
      .values({ ...campaign, maxSessions: 2 });

    expect(await materialiseHorizon(env, NOW)).toHaveLength(2);
    expect(await materialiseHorizon(env, NOW)).toEqual([]);

    const state = await db(env)
      .select({ state: schema.campaigns.state })
      .from(schema.campaigns)
      .get();
    // Nothing terminal is entered by a cron job on a Tuesday morning.
    expect(state?.state).toBe("RUNNING");
  });

  it("takes its length from the campaign's game when it has one", async () => {
    await db(env)
      .insert(schema.games)
      .values({ id: "mork-borg", name: "Mörk Borg", defaultDurationMinutes: 180 });
    await db(env)
      .insert(schema.campaigns)
      .values({ ...campaign, gameId: "mork-borg" });

    const rows = await sessions().then(() => materialiseHorizon(env, NOW)).then(() => sessions());
    expect(rows[0]!.endsAt - rows[0]!.startsAt).toBe(180 * 60);
  });
});

describe("the jobs a new session arms", () => {
  it("asks for the projection now and the post at its lead time", async () => {
    await db(env).insert(schema.campaigns).values(campaign);
    const [first] = await materialiseHorizon(env, NOW);

    const armed = (await jobs()).filter((job) => job.payload !== null);
    const project = armed.find((job) => job.id === `session.project:${first!.sessionId}`);
    const post = armed.find((job) => job.id === `session.post-attendance:${first!.sessionId}`);

    expect(project).toMatchObject({ kind: "session.project", state: "pending" });
    // The post is a job, not a post made here: a post is the one thing that
    // cannot be taken back, so it waits until it is nearly time.
    expect(post?.runAt).toBe(first!.startsAt - 10 * 86_400);
  });

  it("arms each session's jobs once, however often the tick runs", async () => {
    await db(env).insert(schema.campaigns).values(campaign);
    await materialiseHorizon(env, NOW);
    const before = await jobs();

    await materialiseHorizon(env, NOW);

    expect(await jobs()).toHaveLength(before.length);
  });
});

describe("the clock", () => {
  it("materialises on the hour and not in between", async () => {
    await db(env).insert(schema.campaigns).values(campaign);

    await handleScheduled({ scheduledTime: Date.parse("2026-09-14T12:30:00Z") } as ScheduledController, env);
    expect(await sessions()).toEqual([]);

    await handleScheduled({ scheduledTime: Date.parse("2026-09-14T13:00:00Z") } as ScheduledController, env);
    expect((await sessions()).length).toBeGreaterThan(0);
  });
});
