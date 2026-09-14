import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { db, schema } from "../src/db/index.ts";
import { SETTING_KEYS, setSetting } from "../src/db/settings.ts";
import { DISCORD_EVENT_HORIZON, enforceEventCap, surfacesFor } from "../src/campaigns/event-cap.ts";
import { materialiseHorizon } from "../src/campaigns/materialise.ts";
import type { OutboxMessage } from "../src/env.ts";

/**
 * Discord holds two upcoming events per campaign; D1 and Google run further
 * ahead. What is worth testing is the boundary: the third session is Google-only
 * while it is third, and becomes Discord's the moment the first one passes.
 */
const CAMPAIGN = "age-of-umbra";
const NOW = new Date("2026-09-14T12:00:00Z");
const nowSeconds = Math.floor(NOW.getTime() / 1000);

const campaign = {
  id: CAMPAIGN,
  name: "Age of Umbra",
  kind: "run",
  discordChannelId: "chan-1",
  state: "RUNNING",
  recurrenceAnchor: Math.floor(Date.parse("2024-01-06T19:00:00Z") / 1000),
  intervalWeeks: 2,
  firstSessionNumber: 1,
} as const;

let sent: OutboxMessage[] = [];

function outboxEnv() {
  return {
    ...env,
    OUTBOX: {
      sendBatch: async (messages: { body: OutboxMessage }[]) => {
        sent.push(...messages.map((m) => m.body));
      },
      send: async (body: OutboxMessage) => {
        sent.push(body);
      },
    },
  } as unknown as typeof env;
}

/** A session of this campaign, `days` from now, optionally already projected. */
async function session(id: string, days: number, discordEventId: string | null = null) {
  await db(env)
    .insert(schema.sessions)
    .values({
      id,
      kind: "campaign_session",
      campaignId: CAMPAIGN,
      startsAt: nowSeconds + days * 86_400,
      endsAt: nowSeconds + days * 86_400 + 4 * 3600,
      ...(discordEventId === null ? {} : { discordEventId }),
    });
}

beforeEach(async () => {
  sent = [];
  for (const table of ["jobs", "sessions", "campaigns", "games", "settings"]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  await setSetting(env, SETTING_KEYS.timezone, "Europe/London");
  await db(env).insert(schema.campaigns).values(campaign);
});

describe("which surfaces a session is published to", () => {
  it("gives the next two both surfaces and everything after them Google alone", async () => {
    await session("s1", 3);
    await session("s2", 17);
    await session("s3", 31);

    expect(await surfacesFor(env, "s1", NOW)).toEqual(["discord", "google"]);
    expect(await surfacesFor(env, "s2", NOW)).toEqual(["discord", "google"]);
    // Google has no per-guild cap and no disposability, so there is no reason to
    // keep the calendar short — somebody subscribing wants to see October.
    expect(await surfacesFor(env, "s3", NOW)).toEqual(["google"]);
  });

  it("counts upcoming only, so a past session does not use up a slot", async () => {
    await session("past", -14);
    await session("s1", 3);
    await session("s2", 17);

    expect(await surfacesFor(env, "s1", NOW)).toContain("discord");
    expect(await surfacesFor(env, "s2", NOW)).toContain("discord");
  });

  it("gives a one-off both, having no campaign to be third in", async () => {
    await db(env).insert(schema.sessions).values({
      id: "one-off",
      kind: "one_off",
      campaignId: null,
      startsAt: nowSeconds + 90 * 86_400,
      endsAt: nowSeconds + 90 * 86_400 + 3600,
    });

    expect(await surfacesFor(env, "one-off", NOW)).toEqual(["discord", "google"]);
  });

  it("holds the horizon at two", () => {
    expect(DISCORD_EVENT_HORIZON).toBe(2);
  });
});

describe("rolling the horizon forward", () => {
  it("asks for an event for a session inside the cap that has none", async () => {
    await session("s1", 3);
    await session("s2", 17);

    await enforceEventCap(outboxEnv(), CAMPAIGN, NOW);

    expect(sent).toEqual([
      { kind: "discord.event.upsert", sessionId: "s1" },
      { kind: "discord.event.upsert", sessionId: "s2" },
    ]);
  });

  it("takes down the event of a session that is no longer one of the next two", async () => {
    await session("s1", 3, "evt-1");
    await session("s2", 17, "evt-2");
    await session("s3", 31, "evt-3");

    await enforceEventCap(outboxEnv(), CAMPAIGN, NOW);

    // The retraction goes through the ledger, so taking an event down does not
    // lose the record that it was up.
    expect(sent).toEqual([{ kind: "discord.event.delete", sessionId: "s3" }]);
  });

  it("asks for nothing when everything is already where it should be", async () => {
    await session("s1", 3, "evt-1");
    await session("s2", 17, "evt-2");
    await session("s3", 31);

    await enforceEventCap(outboxEnv(), CAMPAIGN, NOW);

    // Re-enqueuing these would spend a rate-limit slot writing what is written.
    expect(sent).toEqual([]);
  });

  it("leaves a past session's event alone", async () => {
    await session("past", -14, "evt-old");
    await session("s1", 3, "evt-1");
    await session("s2", 17, "evt-2");

    await enforceEventCap(outboxEnv(), CAMPAIGN, NOW);

    // The cap counts upcoming. An event for a session that already happened is a
    // record of it, not clutter.
    expect(sent).toEqual([]);
  });

  it("promotes the third session once the first has passed", async () => {
    await session("s1", 3, "evt-1");
    await session("s2", 17, "evt-2");
    await session("s3", 31);

    const later = new Date(NOW.getTime() + 7 * 86_400_000);
    await enforceEventCap(outboxEnv(), CAMPAIGN, later);

    // s1 is in the past now, so s2 and s3 are the next two and s3 wants an event.
    expect(sent).toEqual([{ kind: "discord.event.upsert", sessionId: "s3" }]);
  });
});

describe("the hourly tick, with the cap", () => {
  it("rolls the horizon for a campaign that gained nothing this hour", async () => {
    await setSetting(env, SETTING_KEYS.horizonSessions, 3);
    const e = outboxEnv();

    await materialiseHorizon(e, NOW);
    const made = await db(env).select().from(schema.sessions).all();
    expect(made).toHaveLength(3);

    // Pretend the first two were projected, then run the tick again with nothing
    // new to make. The cap still has to be enforced.
    const byStart = made.sort((a, b) => a.startsAt - b.startsAt);
    for (const [i, row] of byStart.slice(0, 2).entries()) {
      await db(env)
        .update(schema.sessions)
        .set({ discordEventId: `evt-${i}` })
        .where(eq(schema.sessions.id, row.id));
    }
    sent = [];

    await materialiseHorizon(e, NOW);

    // Nothing was made, and the third session is correctly Google-only: no
    // upsert for it, and no retraction because it never had an event.
    expect(sent).toEqual([]);
  });
});
