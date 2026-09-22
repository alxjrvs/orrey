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

/**
 * `onRoster` defaults to true because that is the ordinary case — nearly everybody
 * who answers is somebody the session is for. The tests that care pass `false`,
 * and they are the interesting ones: which rule applies, and whose `out` counts.
 */
const row = (
  id: string,
  intent: AttendanceRow["intent"],
  onRoster = true,
): AttendanceRow => ({
  userId: id,
  name: `Player ${id}`,
  intent,
  note: null,
  onRoster,
});

async function addMembers(...userIds: string[]) {
  for (const userId of userIds) {
    await db(env)
      .insert(schema.users)
      .values({ discordId: userId, username: `p${userId}`, feedToken: `t-${userId}` })
      .onConflictDoNothing();
  }
  await db(env)
    .insert(schema.campaignMembers)
    .values(userIds.map((userId) => ({ campaignId: "age-of-umbra", userId })))
    .onConflictDoNothing();
}

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

  for (const table of [
    "publications",
    "attendance",
    "campaign_members",
    "jobs",
    "sessions",
    "campaigns",
    "users",
    "settings",
  ]) {
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

  it("never confirms a campaign with no quorum and nobody on the roster", async () => {
    await setQuorum(null);
    // Nobody is assigned, so there is no table to be unanimous about — the
    // campaign falls back to counting, and a campaign with no quorum is not
    // "quorum of zero": it has not been asked, and it never confirms on its own.
    const rows = [row("1", "in", false), row("2", "in", false), row("3", "in", false)];

    const quorum = quorumOf(await target(), rows);
    expect(quorum).toMatchObject({ rule: "quorum", required: null, met: false, roster: 0 });
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
      onRoster: true,
    }));

    const payload = renderAttendancePost({ target: await target(), rows: many, asOf });

    // A post shortened past the one line that answers "does it run" is a post
    // worth nothing.
    expect(payload.content.length).toBeLessThanOrEqual(1900);
    expect(payload.content).toContain("**Confirmed**");
  });

  it("says nothing about quorum when the campaign set none and has no roster", async () => {
    await setQuorum(null);
    const payload = renderAttendancePost({
      target: await target(),
      rows: [row("1", "in", false)],
      asOf,
    });

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

describe("a session that was marked short", () => {
  const actor = (id: string) => ({ id, username: `p${id}`, global_name: null });

  function lock() {
    return env.SESSION_LOCK.get(env.SESSION_LOCK.idFromName(SESSION_ID));
  }

  it("confirms when the table turns up after all", async () => {
    await setQuorum(2);
    await db(env)
      .update(schema.sessions)
      .set({ state: "JEOPARDY" })
      .where(eq(schema.sessions.id, SESSION_ID));

    await lock().setIntent({ sessionId: SESSION_ID, actor: actor("1"), intent: "in" });
    await lock().setIntent({ sessionId: SESSION_ID, actor: actor("2"), intent: "in" });

    // Being marked short a day out is a question asked of the table, not a
    // terminal state — and somebody answering by turning up is the whole point
    // of asking. Refusing to confirm would leave the post reading "Confirmed"
    // over a session D1 says is in jeopardy, for ever, with no click able to fix
    // it.
    expect(
      await db(env)
        .select({ state: schema.sessions.state })
        .from(schema.sessions)
        .where(eq(schema.sessions.id, SESSION_ID))
        .get(),
    ).toMatchObject({ state: "CONFIRMED" });
  });
});

/**
 * The veto default (#173). Once a campaign has a roster the question stops being
 * "how many" and becomes "does anybody object" — so these tests are about a rule
 * with no number in it at all.
 */
describe("the veto rule", () => {
  beforeEach(async () => {
    await setQuorum(null);
  });

  it("applies to a campaign past FORMING with somebody on the roster", async () => {
    const quorum = quorumOf(await target(), [row("1", null), row("2", null)]);

    // Nobody has clicked anything. It is on regardless, and there is no
    // threshold to report — a roster size rendered as `required` would put
    // "0 of 2 in" over a session that is going ahead.
    expect(quorum).toMatchObject({
      rule: "unanimous",
      required: null,
      roster: 2,
      vetoes: [],
      met: true,
    });
  });

  it("is not met the moment one person on the roster says out", async () => {
    const quorum = quorumOf(await target(), [row("1", "in"), row("2", "out"), row("3", null)]);

    expect(quorum).toMatchObject({ rule: "unanimous", vetoes: ["2"], met: false });
  });

  it("does not count maybe as a veto", async () => {
    // "Maybe" is not "cannot make it". Under a rule where one `out` moves the
    // evening, treating hesitation as a veto would move it constantly.
    expect(quorumOf(await target(), [row("1", "maybe"), row("2", null)])).toMatchObject({
      vetoes: [],
      met: true,
    });
  });

  it("ignores an out from somebody who has left the table", async () => {
    const quorum = quorumOf(await target(), [row("1", null), row("2", "out", false)]);

    // A veto is a seat saying it cannot make the date. Somebody who answered and
    // has since left the roster would otherwise hold an evening that is no
    // longer theirs — for ever, with nothing anyone could click to put it back.
    expect(quorum).toMatchObject({ roster: 1, vetoes: [], met: true });
  });

  it("hands back to quorum when the organiser sets one", async () => {
    await setQuorum(3);
    const quorum = quorumOf(await target(), [row("1", "in"), row("2", "out")]);

    // The opt-out, and the only one: that column has always meant "count them".
    expect(quorum).toMatchObject({ rule: "quorum", required: 3, saidIn: 1, vetoes: [] });
  });

  it("hands back to quorum for a campaign on hiatus or concluded", async () => {
    for (const state of ["HIATUS", "CONCLUDED"] as const) {
      await db(env)
        .update(schema.campaigns)
        .set({ state })
        .where(eq(schema.campaigns.id, "age-of-umbra"));

      // Their sessions are not published — `isProjectable` says so — but their
      // posts are still up and still clickable. A paused campaign whose post says
      // "**On**" is Orrey asserting an evening nobody has planned.
      expect(quorumOf(await target(), [row("1", null)])).toMatchObject({ rule: "quorum" });
    }
  });

  it("does not tell a called-off session it is on", async () => {
    await setState("CANCELLED");

    // Refresh is never refused and cancelling deliberately leaves the post alone,
    // so this line is one people are actually shown. It used to read "**On** — 1
    // on the roster … press **Out**", over an evening that was off, at a button
    // `takesIntent` refuses.
    expect(quorumLine(quorumOf(await target(), [row("1", null)]))).toBeUndefined();
  });

  it("stops inviting an answer once the table has stopped moving", async () => {
    await db(env)
      .update(schema.sessions)
      .set({ state: "LOCKED" })
      .where(eq(schema.sessions.id, SESSION_ID));

    const line = quorumLine(quorumOf(await target(), [row("1", null), row("2", null)]))!;
    expect(line).toContain("**On**");
    expect(line).toContain("Locked: answers are closed");
    expect(line).not.toContain("press **Out**");
  });

  it("hands back to quorum for a campaign that has not started", async () => {
    await db(env)
      .update(schema.campaigns)
      .set({ state: "FORMING" })
      .where(eq(schema.campaigns.id, "age-of-umbra"));

    // A forming campaign's roster is its claimants, and a claim is an expression
    // of interest rather than a seat. One of them must not be able to move a
    // date for the people who have actually started playing.
    expect(quorumOf(await target(), [row("1", "out")])).toMatchObject({ rule: "quorum" });
  });

  it("says what silence means, because that is the only thing a reader needs", async () => {
    const line = quorumLine(quorumOf(await target(), [row("1", "in"), row("2", null)]))!;

    expect(line).toContain("**On**");
    expect(line).toContain("2 on the roster");
    expect(line).toContain("Silence counts as in");
  });

  it("says a vetoed session cannot run as it stands, and names the next step", async () => {
    const line = quorumLine(quorumOf(await target(), [row("1", "out"), row("2", null)]))!;

    // Not "cancelled". #1 is explicit that when the answer is no the response is
    // a date poll, and nothing here decides anything.
    expect(line).toContain("Can't run as it stands");
    expect(line).toContain("one person out of 2");
    expect(line).toContain("date poll");
    expect(line).not.toContain("Cancelled");
  });

  it("confirms nothing, because there was never anything to confirm", async () => {
    const actor = { id: "1", username: "p1", global_name: null };
    await addMembers("1", "2");

    await env.SESSION_LOCK.get(env.SESSION_LOCK.idFromName(SESSION_ID)).setIntent({
      sessionId: SESSION_ID,
      actor,
      intent: "in",
    });

    // A session with a roster and no objection is on from the moment it is made.
    // Writing CONFIRMED would post "It's on" about a session whose own post has
    // said exactly that all along.
    expect(
      await db(env)
        .select({ state: schema.sessions.state })
        .from(schema.sessions)
        .where(eq(schema.sessions.id, SESSION_ID))
        .get(),
    ).toMatchObject({ state: "SCHEDULED" });
  });
});
