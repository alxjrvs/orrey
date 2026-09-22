import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { db, schema } from "../src/db/index.ts";
import { createApp } from "../src/http/app.ts";
import { InteractionType } from "../src/discord/types.ts";
import { fakeDiscord } from "./discord.ts";
import {
  renderUpcoming,
  upcomingFor,
  upcomingWithTotal,
  type UpcomingEntry,
} from "../src/commands/upcoming.ts";
import type { Quorum } from "../src/attendance/quorum.ts";

/**
 * A verdict under the counting rule, which is the one `/upcoming` has always
 * rendered. `p8/1` added two fields to the shape and a second rule that answers
 * with them; what this file is about is the wording of a tally, so it states the
 * rule it means rather than leaning on a default.
 */
const counted = (over: Partial<Quorum> = {}): Quorum => ({
  rule: "quorum",
  required: null,
  saidIn: 0,
  roster: 0,
  vetoes: [],
  met: false,
  confirmed: false,
  state: "SCHEDULED",
  slipped: false,
  ...over,
});

/**
 * The agenda. One list across every campaign, read fresh, ephemeral — and the
 * thing it must never do is show somebody a campaign they are not on.
 */
const discord = await fakeDiscord();
const app = createApp();
const ASOF = new Date("2026-09-14T12:00:00Z");
const NOW = Math.floor(ASOF.getTime() / 1000);
const DAY = 86_400;

async function campaign(id: string, name: string, quorum: number | null = null) {
  await db(env)
    .insert(schema.campaigns)
    .values({ id, name, kind: "run", state: "RUNNING", quorum });
}

async function person(id: string) {
  await db(env)
    .insert(schema.users)
    .values({ discordId: id, username: `u${id}`, feedToken: `t-${id}` })
    .onConflictDoNothing();
}

async function member(campaignId: string, userId: string) {
  await person(userId);
  await db(env).insert(schema.campaignMembers).values({ campaignId, userId });
}

// `inDays` counts from `ASOF`, the frozen date the rest of this file hands to
// `upcomingFor` and `renderUpcoming` so both sides agree. A test that goes
// through `app.fetch` gets no such say — the route asks the real clock — so it
// passes `REAL_NOW` and its session is upcoming today as well as on the day this
// was written.
const REAL_NOW = () => Math.floor(Date.now() / 1000);

async function session(
  campaignId: string,
  number: number,
  inDays: number,
  state: "SCHEDULED" | "CONFIRMED" | "JEOPARDY" | "CANCELLED" | "PLAYED" = "SCHEDULED",
  from: number = NOW,
) {
  const startsAt = from + inDays * DAY;
  await db(env).insert(schema.sessions).values({
    id: `${campaignId}-s${number}`,
    kind: "campaign_session",
    campaignId,
    number,
    startsAt,
    endsAt: startsAt + 4 * 3600,
    location: "The Wreck",
    state,
  });
  return `${campaignId}-s${number}`;
}

async function saidIn(sessionId: string, who: string, intent: "in" | "out" | "maybe") {
  await person(who);
  await db(env).insert(schema.attendance).values({ sessionId, userId: who, intent });
}

beforeEach(async () => {
  for (const table of ["attendance", "campaign_members", "jobs", "sessions", "campaigns", "users"]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
});

describe("what is on the list", () => {
  it("is one list across campaigns, in time order, not grouped by campaign", async () => {
    await campaign("umbra", "Age of Umbra");
    await campaign("deeps", "The Deeps");
    await member("umbra", "ada");
    await member("deeps", "ada");
    await session("umbra", 1, 7);
    await session("deeps", 1, 2);
    await session("umbra", 2, 21);

    const entries = await upcomingFor(env, "ada", ASOF);

    // A person in three campaigns reading three lists has to do this merge in
    // their head. That is the command's entire reason for existing.
    expect(entries.map((entry) => entry.sessionId)).toEqual([
      "deeps-s1",
      "umbra-s1",
      "umbra-s2",
    ]);
  });

  it("shows only the campaigns the caller is on", async () => {
    await campaign("umbra", "Age of Umbra");
    await campaign("secret", "Somebody Else's Game");
    await member("umbra", "ada");
    await member("secret", "bo");
    await session("umbra", 1, 3);
    await session("secret", 1, 1);

    const entries = await upcomingFor(env, "ada", ASOF);

    expect(entries.map((entry) => entry.sessionId)).toEqual(["umbra-s1"]);
  });

  it("leaves out what has been called off and what has been played", async () => {
    await campaign("umbra", "Age of Umbra");
    await member("umbra", "ada");
    await session("umbra", 1, 3, "CANCELLED");
    await session("umbra", 2, 4, "PLAYED");
    await session("umbra", 3, 5, "JEOPARDY");

    // Excluded by state, not by time: a session cancelled for next Tuesday is
    // still in the future and still must not be on the agenda.
    expect((await upcomingFor(env, "ada", ASOF)).map((e) => e.sessionId)).toEqual(["umbra-s3"]);
  });

  it("leaves out what has already started", async () => {
    await campaign("umbra", "Age of Umbra");
    await member("umbra", "ada");
    await session("umbra", 1, -1);
    await session("umbra", 2, 1);

    expect((await upcomingFor(env, "ada", ASOF)).map((e) => e.sessionId)).toEqual(["umbra-s2"]);
  });

  it("is empty for somebody on no rosters, and that is an answer", async () => {
    await person("nobody");
    expect(await upcomingFor(env, "nobody", ASOF)).toEqual([]);
    expect(renderUpcoming([], ASOF)).toContain("Nothing upcoming");
  });

  it("carries the caller's own intent, and nobody else's", async () => {
    await campaign("umbra", "Age of Umbra", 3);
    await member("umbra", "ada");
    const id = await session("umbra", 1, 3);
    await saidIn(id, "ada", "maybe");
    await saidIn(id, "bo", "in");
    await saidIn(id, "cy", "in");

    const [entry] = await upcomingFor(env, "ada", ASOF);
    expect(entry).toMatchObject({ mine: "maybe" });
    expect(entry?.quorum).toMatchObject({ required: 3, saidIn: 2, met: false });
  });
});

describe("how it reads", () => {
  const entry = (over: Partial<UpcomingEntry> = {}): UpcomingEntry => ({
    sessionId: "umbra-s1",
    title: "Age of Umbra — Session 1",
    startsAt: NOW + 3 * DAY,
    state: "SCHEDULED",
    quorum: counted(),
    mine: null,
    ...over,
  });

  it("renders every time as the reader's own, never as a wall clock", () => {
    const content = renderUpcoming([entry()], ASOF);

    // One line has to be right for a table spread across three time zones.
    expect(content).toContain(`<t:${NOW + 3 * DAY}:F>`);
    expect(content).not.toMatch(/\d{2}:\d{2} (UTC|GMT)/);
  });

  it("says how many more it takes, not just the tally", () => {
    const content = renderUpcoming(
      [entry({ quorum: counted({ required: 4, saidIn: 2 }) })],
      ASOF,
    );

    // "Short by 2" is a number somebody can act on. "2 of 4" is arithmetic
    // homework.
    expect(content).toContain("short by 2");
  });

  it("says nothing about quorum for a campaign that set none", () => {
    expect(renderUpcoming([entry()], ASOF)).not.toMatch(/short by|confirmed/);
  });

  it("says confirmed, and says when a confirmed session has slipped", () => {
    const confirmed = counted({ required: 3, saidIn: 3, met: true, confirmed: true });
    expect(renderUpcoming([entry({ state: "CONFIRMED", quorum: confirmed })], ASOF)).toContain(
      "confirmed",
    );

    const slipped = counted({ required: 3, saidIn: 1, confirmed: true, slipped: true });
    expect(renderUpcoming([entry({ state: "CONFIRMED", quorum: slipped })], ASOF)).toContain(
      "confirmed, 1 of 3 in now",
    );
  });

  it("says on, and nothing that reads like a shortfall", () => {
    const unanimous = counted({
      rule: "unanimous",
      required: null,
      saidIn: 3,
      roster: 5,
      met: true,
    });

    const content = renderUpcoming([entry({ quorum: unanimous })], ASOF);
    // "3 of 5 in" over a session that is going ahead is exactly the reading the
    // veto rule exists to stop, and `/upcoming` is where six of them are skimmed
    // at once.
    expect(content).toContain("on");
    expect(content).not.toMatch(/\d+ of \d+ in/);
    expect(content).not.toContain("short by");
  });

  it("says a vetoed session is moving, and how many are out", () => {
    const vetoed = counted({
      rule: "unanimous",
      required: null,
      saidIn: 2,
      roster: 4,
      vetoes: ["p-1"],
    });

    expect(renderUpcoming([entry({ state: "JEOPARDY", quorum: vetoed })], ASOF)).toContain(
      "moving — 1 person of 4 out",
    );
  });

  it("says in jeopardy for a session the clock has marked", () => {
    const content = renderUpcoming(
      [
        entry({
          state: "JEOPARDY",
          quorum: counted({ required: 4, saidIn: 1 }),
        }),
      ],
      ASOF,
    );
    expect(content).toContain("in jeopardy — 1 of 4 in");
  });

  it("calls out that the caller has not said, because that is the ask", () => {
    expect(renderUpcoming([entry()], ASOF)).toContain("you have not said");
    expect(renderUpcoming([entry({ mine: "in" })], ASOF)).toContain("you: in");
  });

  it("carries its own as-of, because it is not a snapshot", () => {
    expect(renderUpcoming([entry()], ASOF)).toContain(`<t:${NOW}:t>`);
  });
});

describe("the command", () => {
  it("answers the caller ephemerally with their own agenda", async () => {
    await campaign("umbra", "Age of Umbra", 2);
    await member("umbra", "1001");
    await session("umbra", 7, 4, "SCHEDULED", REAL_NOW());

    const res = await app.fetch(
      await discord.request({
        type: InteractionType.APPLICATION_COMMAND,
        data: { name: "upcoming" },
        member: { user: { id: "1001", username: "ada", global_name: "Ada" }, roles: [] },
        guild_id: "g",
      }),
      discord.env(env),
    );

    const json = (await res.json()) as { data: { content: string; flags: number } };
    expect(json.data.content).toContain("Age of Umbra — Session 7");
    expect(json.data.content).not.toContain("still being built");
    expect(json.data.flags & 64).toBeTruthy();
  });

  it("tells somebody on no rosters so, rather than failing", async () => {
    const res = await app.fetch(
      await discord.request({
        type: InteractionType.APPLICATION_COMMAND,
        data: { name: "upcoming" },
        member: { user: { id: "2002", username: "bo", global_name: null }, roles: [] },
        guild_id: "g",
      }),
      discord.env(env),
    );

    expect(((await res.json()) as { data: { content: string } }).data.content).toContain(
      "Nothing upcoming",
    );
  });

  it("writes nothing — it is a read and an ephemeral answer", async () => {
    await campaign("umbra", "Age of Umbra");
    await member("umbra", "1001");
    await session("umbra", 1, 2, "SCHEDULED", REAL_NOW());

    await app.fetch(
      await discord.request({
        type: InteractionType.APPLICATION_COMMAND,
        data: { name: "upcoming" },
        member: { user: { id: "1001", username: "ada", global_name: "Ada" }, roles: [] },
        guild_id: "g",
      }),
      discord.env(env),
    );

    expect(await db(env).select().from(schema.attendance).all()).toEqual([]);
    expect(await db(env).select().from(schema.jobs).all()).toEqual([]);
    expect(
      await db(env).select().from(schema.sessions).where(eq(schema.sessions.id, "umbra-s1")).get(),
    ).toMatchObject({ state: "SCHEDULED" });
  });
});

describe("a list longer than the command shows", () => {
  it("heads the answer with the real total, not the length of what it cut", async () => {
    await campaign("umbra", "Age of Umbra");
    await member("umbra", "ada");
    for (let n = 1; n <= 14; n++) await session("umbra", n, n);

    const { entries, total } = await upcomingWithTotal(env, "ada", ASOF);
    const content = renderUpcoming(entries, ASOF, total);

    // "10 sessions" over a list of ten when there are fourteen is a wrong answer
    // to the question the command asks.
    expect(entries).toHaveLength(10);
    expect(total).toBe(14);
    expect(content).toContain("**Upcoming — 14 sessions**");
    expect(content).toContain("4 more beyond these");
  });

  it("says nothing about more when there is no more", async () => {
    await campaign("umbra", "Age of Umbra");
    await member("umbra", "ada");
    await session("umbra", 1, 3);

    const { entries, total } = await upcomingWithTotal(env, "ada", ASOF);
    expect(renderUpcoming(entries, ASOF, total)).not.toContain("beyond these");
  });
});
