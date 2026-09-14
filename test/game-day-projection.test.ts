import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { db, schema } from "../src/db/index.ts";
import { SETTING_KEYS, setSetting } from "../src/db/settings.ts";
import { mintId } from "../src/db/ids.ts";
import type { Env, OutboxMessage } from "../src/env.ts";
import { scheduledEventBody } from "../src/discord/events.ts";
import { handleQueueBatch } from "../src/queue/consumer.ts";
import {
  googleFingerprint,
  isProjectable,
  loadProjectionTarget,
  locationOf,
  sessionTitle,
} from "../src/projection/target.ts";

/**
 * The target grows a second parent.
 *
 * Everything a game day publishes is machinery phases 1–3 already built: the
 * Discord event, the Google event, the thread, the attendance post. What had to
 * change is the one object all of them read — so what is worth testing is that
 * neither projector gained a branch, and that `isProjectable` now asks whichever
 * parent is there rather than testing for absence.
 */
const START = Date.parse("2026-11-07T18:00:00Z") / 1000;
const SESSION_ID = "one-off-1";

function batchOf(...bodies: OutboxMessage[]) {
  const messages = bodies.map((body, i) => ({
    id: `m${i}`,
    timestamp: new Date(),
    body,
    attempts: 1,
    ack: vi.fn(),
    retry: vi.fn(),
  }));
  return {
    batch: { queue: "orrey-outbox", messages } as unknown as MessageBatch<OutboxMessage>,
    messages,
  };
}

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
      endsAt: START + 18_000,
      venue: "The Wreck, back room",
      ...over,
    });
  return id;
}

async function sessionOf(gameDayId: string) {
  await db(env)
    .insert(schema.sessions)
    .values({
      id: SESSION_ID,
      kind: "one_off",
      gameDayId,
      startsAt: START,
      endsAt: START + 18_000,
    });
  return (await loadProjectionTarget(env, SESSION_ID))!;
}

beforeEach(async () => {
  for (const table of [
    "calendar_links",
    "publications",
    "attendance",
    "jobs",
    "sessions",
    "poll_dates",
    "date_polls",
    "game_days",
    "campaigns",
    "games",
    "users",
    "settings",
  ]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  await setSetting(env, SETTING_KEYS.guildId, "g1");
  await db(env)
    .insert(schema.games)
    .values({ id: "blades", name: "Blades in the Dark", maxPlayers: 4 });
});

describe("loading it", () => {
  it("comes back with the day and what the day is playing", async () => {
    const target = await sessionOf(await day());

    expect(target.campaign).toBeNull();
    expect(target.gameDay).toMatchObject({ kind: "single", venue: "The Wreck, back room" });
    expect(target.game).toMatchObject({ name: "Blades in the Dark" });
  });

  it("leaves both null for a campaign's session", async () => {
    await db(env).insert(schema.campaigns).values({ id: "c1", name: "Age of Umbra", kind: "run" });
    await db(env)
      .insert(schema.sessions)
      .values({
        id: "c1-s1",
        kind: "campaign_session",
        campaignId: "c1",
        number: 1,
        startsAt: START,
        endsAt: START + 3600,
      });

    const target = (await loadProjectionTarget(env, "c1-s1"))!;
    expect(target.gameDay).toBeNull();
    expect(target.game).toBeNull();
  });
});

describe("what it is called", () => {
  it("is the game, for a day that plays one", async () => {
    expect(sessionTitle(await sessionOf(await day()))).toBe("Blades in the Dark");
  });

  it("is the day's own title for a multi day", async () => {
    const id = await day({ kind: "multi", gameId: null, title: "November Games Day" });
    expect(sessionTitle(await sessionOf(id))).toBe("November Games Day");
  });

  it("falls back to the day's title when the game has gone", async () => {
    // `game_id` is ON DELETE SET NULL, so a game removed from the library leaves
    // the day standing. A day with no name at all is still better than a crash.
    const id = await day({ gameId: null, title: "Blades in the Dark" });
    expect(sessionTitle(await sessionOf(id))).toBe("Blades in the Dark");
  });

  it("has something to say about a day with neither", async () => {
    expect(sessionTitle(await sessionOf(await day({ kind: "multi", gameId: null })))).toBe(
      "Game day",
    );
  });
});

describe("where it is", () => {
  it("is the day's venue", async () => {
    expect(locationOf(await sessionOf(await day()))).toBe("The Wreck, back room");
  });

  it("is the session's own location when it has one", async () => {
    const id = await day();
    await db(env)
      .insert(schema.sessions)
      .values({
        id: SESSION_ID,
        kind: "one_off",
        gameDayId: id,
        location: "Upstairs, not the back room",
        startsAt: START,
        endsAt: START + 18_000,
      });

    expect(locationOf((await loadProjectionTarget(env, SESSION_ID))!)).toBe(
      "Upstairs, not the back room",
    );
  });

  it("moves the Google fingerprint when the venue moves", async () => {
    const id = await day();
    const before = await googleFingerprint(await sessionOf(id));

    await db(env)
      .update(schema.gameDays)
      .set({ venue: "Somewhere else entirely" })
      .where(eq(schema.gameDays.id, id));

    expect(await googleFingerprint((await loadProjectionTarget(env, SESSION_ID))!)).not.toBe(before);
  });
});

describe("whether Orrey publishes it", () => {
  it("publishes a day that is seating, locked or played", async () => {
    for (const state of ["SEATING", "LOCKED", "PLAYED"] as const) {
      const id = await day({ state });
      await db(env)
        .insert(schema.sessions)
        .values({
          id: `s-${state}`,
          kind: "one_off",
          gameDayId: id,
          startsAt: START,
          endsAt: START + 18_000,
        });
      expect(isProjectable((await loadProjectionTarget(env, `s-${state}`))!)).toBe(true);
    }
  });

  it("does not publish a day nobody has opened seating on", async () => {
    // Fails closed, the way a FORMING campaign does. A proposed day is a date
    // that won a poll, not an event.
    expect(isProjectable(await sessionOf(await day({ state: "PROPOSED" })))).toBe(false);
  });

  it("does not publish a cancelled one", async () => {
    expect(isProjectable(await sessionOf(await day({ state: "CANCELLED" })))).toBe(false);
  });

  it("publishes nothing for a session with no parent at all", async () => {
    await db(env)
      .insert(schema.sessions)
      .values({ id: "orphan", kind: "one_off", startsAt: START, endsAt: START + 3600 });

    // `hasExactlyOneParent` says there should be none of these, and phase 1's
    // CHECK still permits one. The answer is no rather than "always projectable",
    // which is what this function used to say.
    expect(isProjectable((await loadProjectionTarget(env, "orphan"))!)).toBe(false);
  });
});

describe("the Discord event", () => {
  it("is EXTERNAL and carries the venue", async () => {
    const body = scheduledEventBody(await sessionOf(await day()));

    // A day has no campaign, so there is no voice channel to inherit and the
    // VOICE branch above cannot fire.
    expect(body).toMatchObject({
      name: "Blades in the Dark",
      entity_type: 3,
      channel_id: null,
      entity_metadata: { location: "The Wreck, back room" },
    });
  });

  it("says so rather than nothing when the day has no venue yet", async () => {
    const body = scheduledEventBody(await sessionOf(await day({ venue: null })));
    expect(body).toMatchObject({ entity_metadata: { location: "To be confirmed" } });
  });
});

describe("the retraction", () => {
  it("still goes out for a cancelled day", async () => {
    const realFetch = globalThis.fetch;
    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calls.push(String(typeof input === "string" ? input : (input as Request).url ?? input));
      return new Response(null, { status: 204 });
    }) as typeof fetch;

    try {
      const id = await day({ state: "CANCELLED" });
      await sessionOf(id);
      await db(env)
        .update(schema.sessions)
        .set({ discordEventId: "evt-1" })
        .where(eq(schema.sessions.id, SESSION_ID));

      const { batch, messages } = batchOf({ kind: "discord.event.delete", sessionId: SESSION_ID });
      await handleQueueBatch(batch, env, {} as ExecutionContext);

      // The delete is not gated on projectability — it is the opposite of
      // publishing, and a day called off after its event went up is exactly when
      // the event has to come down.
      expect(messages[0]?.ack).toHaveBeenCalled();
      expect(calls.some((url) => url.includes("scheduled-events/evt-1"))).toBe(true);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
