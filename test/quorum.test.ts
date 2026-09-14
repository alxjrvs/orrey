import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db, schema } from "../src/db/index.ts";
import { SETTING_KEYS, setSetting } from "../src/db/settings.ts";
import { seedStatements } from "../src/db/seed-sql.ts";
import { loadProjectionTarget } from "../src/projection/target.ts";
import { renderAttendancePost, type AttendanceRow } from "../src/attendance/render.ts";
import { quorumLine, quorumOf } from "../src/attendance/quorum.ts";

/**
 * Does it run. The question the whole phase is named after, and the one thing a
 * shortened post must never drop.
 */
const realFetch = globalThis.fetch;
const SESSION_ID = "age-of-umbra-s12";
const asOf = new Date("2026-09-18T12:00:00Z");

const campaign = {
  name: "Age of Umbra",
  kind: "run",
  discordChannelId: "chan-1",
  discordRoleId: "role-1",
} as const;

const session = {
  number: 12,
  startsAt: Date.parse("2026-09-20T19:00:00Z") / 1000,
  endsAt: Date.parse("2026-09-20T23:00:00Z") / 1000,
  location: "The Wreck",
};

const row = (id: string, intent: AttendanceRow["intent"]): AttendanceRow => ({
  userId: id,
  name: `Player ${id}`,
  intent,
  note: null,
});

async function target() {
  return (await loadProjectionTarget(env, SESSION_ID))!;
}

async function setQuorum(quorum: number | null) {
  await db(env)
    .update(schema.campaigns)
    .set({ quorum })
    .where(eq(schema.campaigns.id, "age-of-umbra"));
}

async function setState(state: "SCHEDULED" | "CONFIRMED" | "CANCELLED") {
  await db(env)
    .update(schema.sessions)
    .set({ state })
    .where(eq(schema.sessions.id, SESSION_ID));
}

beforeEach(async () => {
  globalThis.fetch = (async () =>
    Response.json({ id: "msg-1", channel_id: "chan-1" })) as typeof fetch;

  for (const table of ["publications", "attendance", "jobs", "sessions", "campaigns", "users", "settings"]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  await setSetting(env, SETTING_KEYS.guildId, "g1");
  for (const statement of seedStatements(campaign, session)) {
    await env.DB.prepare(statement).run();
  }
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("the rule", () => {
  it("counts only the people who said in", async () => {
    await setQuorum(3);
    const rows = [row("1", "in"), row("2", "in"), row("3", "maybe"), row("4", "out"), row("5", null)];

    expect(quorumOf(await target(), rows)).toMatchObject({
      required: 3,
      saidIn: 2,
      met: false,
      confirmed: false,
    });
  });

  it("is met at the threshold, not past it", async () => {
    await setQuorum(3);
    const three = [row("1", "in"), row("2", "in"), row("3", "in")];

    expect(quorumOf(await target(), three).met).toBe(true);
    expect(quorumOf(await target(), three.slice(0, 2)).met).toBe(false);
  });

  it("never confirms a campaign that was never asked the question", async () => {
    await setQuorum(null);
    const rows = [row("1", "in"), row("2", "in"), row("3", "in")];

    // A campaign with no quorum is not "quorum of zero" — it has not been asked,
    // and it never confirms on its own.
    const quorum = quorumOf(await target(), rows);
    expect(quorum).toMatchObject({ required: null, met: false });
    expect(quorumLine(quorum)).toBeUndefined();
  });

  it("says when a confirmed session has slipped, and decides nothing", async () => {
    await setQuorum(3);
    await setState("CONFIRMED");

    const quorum = quorumOf(await target(), [row("1", "in")]);
    expect(quorum).toMatchObject({ confirmed: true, met: false, slipped: true });

    const line = quorumLine(quorum)!;
    // Whether a confirmed session is still on once somebody drops out is the
    // organiser's call. The post surfaces it; Orrey does not act on it.
    expect(line).toContain("Confirmed");
    expect(line).toContain("1 of 3");
    expect(line).toContain("unless the GM says otherwise");
  });
});

describe("the post", () => {
  it("carries the answer, and carries it last", async () => {
    await setQuorum(2);
    const payload = renderAttendancePost({
      target: await target(),
      rows: [row("1", "in"), row("2", "in")],
      asOf,
    });

    expect(payload.content).toContain("**Confirmed** — 2 of 2 in.");
  });

  it("keeps the answer even when the post has to be shortened", async () => {
    await setQuorum(2);
    const many = Array.from({ length: 120 }, (_, i) => ({
      userId: `n${i}`,
      name: `A Player With A Rather Long Display Name ${i}`,
      intent: "in" as const,
      note: `and a note that goes on for a while too ${i}`,
    }));

    const payload = renderAttendancePost({ target: await target(), rows: many, asOf });

    // A post shortened past the one line that answers "does it run" is a post
    // worth nothing.
    expect(payload.content.length).toBeLessThanOrEqual(1900);
    expect(payload.content).toContain("**Confirmed**");
  });

  it("says nothing about quorum when the campaign set none", async () => {
    await setQuorum(null);
    const payload = renderAttendancePost({ target: await target(), rows: [row("1", "in")], asOf });

    expect(payload.content).not.toContain("Confirmed");
    // "Age of Umbra" contains " of ", so the assertion has to be the shape of
    // the tally rather than any two words that look like one.
    expect(payload.content).not.toMatch(/\d+ of \d+ in/);
  });
});

describe("the click that crosses it", () => {
  const actor = (id: string) => ({ id, username: `p${id}`, global_name: null });

  function lock() {
    return env.SESSION_LOCK.get(env.SESSION_LOCK.idFromName(SESSION_ID));
  }

  function stateOf() {
    return db(env)
      .select({ state: schema.sessions.state })
      .from(schema.sessions)
      .where(eq(schema.sessions.id, SESSION_ID))
      .get()
      .then((row) => row?.state);
  }

  it("confirms the session, and the one before it does not", async () => {
    await setQuorum(2);

    await lock().setIntent({ sessionId: SESSION_ID, actor: actor("1"), intent: "in" });
    expect(await stateOf()).toBe("SCHEDULED");

    await lock().setIntent({ sessionId: SESSION_ID, actor: actor("2"), intent: "in" });
    expect(await stateOf()).toBe("CONFIRMED");
  });

  it("leaves a session confirmed when somebody drops out", async () => {
    await setQuorum(2);
    await lock().setIntent({ sessionId: SESSION_ID, actor: actor("1"), intent: "in" });
    await lock().setIntent({ sessionId: SESSION_ID, actor: actor("2"), intent: "in" });

    await lock().setIntent({ sessionId: SESSION_ID, actor: actor("2"), intent: "out" });

    // Orrey surfaces it and does not decide it.
    expect(await stateOf()).toBe("CONFIRMED");
  });

  it("does not confirm a session that is no longer waiting to be", async () => {
    await setQuorum(1);
    await setState("CANCELLED");

    await lock().setIntent({ sessionId: SESSION_ID, actor: actor("1"), intent: "in" });

    expect(await stateOf()).toBe("CANCELLED");
  });

  it("produces one crossing however many click at once", async () => {
    await setQuorum(2);

    await Promise.all([
      lock().setIntent({ sessionId: SESSION_ID, actor: actor("1"), intent: "in" }),
      lock().setIntent({ sessionId: SESSION_ID, actor: actor("2"), intent: "in" }),
      lock().setIntent({ sessionId: SESSION_ID, actor: actor("3"), intent: "in" }),
    ]);

    expect(await stateOf()).toBe("CONFIRMED");
    expect(await db(env).select().from(schema.attendance).all()).toHaveLength(3);
  });
});
