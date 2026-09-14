import { env } from "cloudflare:test";
import { asc, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db, schema } from "../src/db/index.ts";
import { SETTING_KEYS, setSetting } from "../src/db/settings.ts";
import { createApp } from "../src/http/app.ts";
import { SESSION_COOKIE, issueSession } from "../src/console/cookies.ts";
import { campaignPage } from "../src/console/campaign.ts";
import { campaignPolls } from "../src/console/campaign-polls.ts";
import { rosterOf } from "../src/campaigns/roster.ts";

/**
 * Entering a campaign and moving it through its lifecycle.
 *
 * The claim worth testing is #25's last bullet: every write goes through the
 * same domain functions the bot uses and lands in `audit_log`. So most of these
 * assert on the log as much as on the row.
 */
const app = createApp();
const realFetch = globalThis.fetch;
const NOW = new Date("2026-09-14T12:00:00Z");
const seconds = Math.floor(NOW.getTime() / 1000);
const ORGANISER_ROLE = "role-organiser";

let roles = [ORGANISER_ROLE];

function consoleEnv() {
  return {
    ...env,
    CONSOLE_SESSION_SECRET: "a-secret",
    DISCORD_APPLICATION_ID: "app-1",
    DISCORD_CLIENT_SECRET: "shh",
    DISCORD_BOT_TOKEN: "bot-token",
  };
}

async function cookie() {
  return `${SESSION_COOKIE}=${await issueSession(consoleEnv(), "1001", new Date())}`;
}

async function send(method: string, path: string, body?: unknown) {
  return app.fetch(
    new Request(`https://orrey.test${path}`, {
      method,
      headers: { cookie: await cookie(), "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    consoleEnv(),
  );
}

const valid = {
  name: "Age of Umbra",
  kind: "run",
  discordChannelId: "chan-1",
  discordRoleId: "role-1",
  recurrenceAnchor: seconds,
  intervalWeeks: 2,
  quorum: 3,
  firstSessionNumber: 12,
};

function audit() {
  return db(env).select().from(schema.auditLog).orderBy(asc(schema.auditLog.createdAt)).all();
}

function campaign(id = "age-of-umbra") {
  return db(env).select().from(schema.campaigns).where(eq(schema.campaigns.id, id)).get();
}

beforeEach(async () => {
  roles = [ORGANISER_ROLE];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("/members/")) return Response.json({ roles });
    return new Response("unexpected", { status: 500 });
  }) as typeof fetch;

  for (const table of [
    "audit_log",
    "poll_responses",
    "poll_dates",
    "date_polls",
    "calendar_links",
    "attendance",
    "campaign_members",
    "signups",
    "sessions",
    "campaigns",
    "games",
    "discord_tokens",
    "users",
    "settings",
  ]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  await setSetting(env, SETTING_KEYS.guildId, "g1");
  await setSetting(env, SETTING_KEYS.organiserRoleId, ORGANISER_ROLE);
  await db(env).insert(schema.users).values({ discordId: "1001", username: "ada", feedToken: "t" });
  // Against the real clock rather than `NOW`. `sessionFrom` compares this to the
  // clock it is actually running on, so an expiry anchored to a frozen date is a
  // day of life measured from a day already gone. Every test through here then
  // takes the refresh path into a fake fetch that has no token reply, and the
  // file turns red on a change to nothing.
  await db(env)
    .insert(schema.discordTokens)
    .values({ userId: "1001", accessToken: "at", refreshToken: "rt", expiresAt: Math.floor(Date.now() / 1000) + 86_400 });
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("entering a campaign", () => {
  it("creates it FORMING, with the log entry in the same breath", async () => {
    const response = await send("POST", "/api/campaigns", valid);

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ id: "age-of-umbra" });

    // FORMING, not RUNNING: starting a campaign closes its roster, and that goes
    // through `transition` like every other move.
    expect(await campaign()).toMatchObject({
      state: "FORMING",
      intervalWeeks: 2,
      firstSessionNumber: 12,
    });

    expect(await audit()).toMatchObject([
      { actorUserId: "1001", action: "campaign.create", targetId: "age-of-umbra" },
    ]);
  });

  it("refuses a second campaign of the same name", async () => {
    await send("POST", "/api/campaigns", valid);
    const response = await send("POST", "/api/campaigns", valid);

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining("already") });
  });

  it("refuses the numbers that would break the materialiser", async () => {
    for (const [field, value, hint] of [
      ["intervalWeeks", 0, "never advances"],
      ["maxSessions", 0, "concluded"],
      ["firstSessionNumber", -1, "negative"],
    ] as const) {
      const response = await send("POST", "/api/campaigns", { ...valid, [field]: value });
      expect(response.status, field).toBe(400);
      expect((await response.json()) as { error: string }).toMatchObject({
        error: expect.stringContaining(hint),
      });
    }

    // Refused writes are not history.
    expect(await audit()).toEqual([]);
  });

  it("refuses a body missing the two things a campaign cannot be without", async () => {
    // Each of these used to be a 500: no kind reached the NOT NULL constraint,
    // and no name reached `slugify(undefined)`. A bad request wearing a fault's
    // clothes is a bad request nobody reports.
    const noKind = await send("POST", "/api/campaigns", { ...valid, kind: undefined });
    expect(noKind.status).toBe(400);

    const noName = await send("POST", "/api/campaigns", { ...valid, name: undefined });
    expect(noName.status).toBe(400);

    // And a kind that is not one of the three was stored happily.
    const nonsense = await send("POST", "/api/campaigns", { ...valid, kind: "banana" });
    expect(nonsense.status).toBe(400);

    expect(await db(env).select().from(schema.campaigns).all()).toEqual([]);
  });

  it("refuses a voice campaign with nowhere to be", async () => {
    // Not mentioning the channel is the common way to get this wrong, and the
    // guard used to look only for an explicit null.
    const response = await send("POST", "/api/campaigns", { ...valid, locationType: "voice" });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: expect.stringContaining("voice channel id"),
    });
  });

  it("refuses half a cadence", async () => {
    const noInterval = await send("POST", "/api/campaigns", {
      ...valid,
      intervalWeeks: undefined,
    });
    expect(noInterval.status).toBe(400);

    // Neither half is fine: the campaign simply is not materialised.
    const neither = await send("POST", "/api/campaigns", {
      name: "Occasional",
      kind: "run",
    });
    expect(neither.status).toBe(201);
  });
});

describe("editing one", () => {
  beforeEach(async () => {
    await send("POST", "/api/campaigns", valid);
    await env.DB.prepare("DELETE FROM audit_log").run();
  });

  it("changes what it was told about and nothing else", async () => {
    const response = await send("PATCH", "/api/campaigns/age-of-umbra", { quorum: 4 });

    expect(response.status).toBe(200);
    const row = await campaign();
    expect(row?.quorum).toBe(4);
    // The ids somebody pasted in on a different page are still there.
    expect(row).toMatchObject({ discordChannelId: "chan-1", intervalWeeks: 2 });
  });

  it("logs both sides of what moved, and only what moved", async () => {
    await send("PATCH", "/api/campaigns/age-of-umbra", { quorum: 4 });

    expect(await audit()).toMatchObject([
      {
        action: "campaign.update",
        detail: { before: { quorum: 3 }, after: { quorum: 4 } },
      },
    ]);
  });

  it("will not set the state, whatever the body says", async () => {
    await send("PATCH", "/api/campaigns/age-of-umbra", { state: "CONCLUDED", quorum: 5 });

    // A form that could conclude a campaign would be a second way to do the one
    // thing that is meant to have exactly one.
    expect(await campaign()).toMatchObject({ state: "FORMING", quorum: 5 });
  });

  it("lets a partial edit alone about fields it did not mention", async () => {
    // The campaign already has an anchor. Sending only the interval used to be
    // refused as "half a cadence" — a valid edit rejected for a field it did not
    // mention, because the rule was read against the request rather than the row.
    const response = await send("PATCH", "/api/campaigns/age-of-umbra", { intervalWeeks: 3 });

    expect(response.status).toBe(200);
    expect(await campaign()).toMatchObject({ intervalWeeks: 3 });
  });

  it("still refuses an edit that would leave half a cadence behind", async () => {
    const response = await send("PATCH", "/api/campaigns/age-of-umbra", {
      recurrenceAnchor: null,
    });
    expect(response.status).toBe(400);
  });

  it("says so plainly about a campaign that does not exist", async () => {
    const response = await send("PATCH", "/api/campaigns/nope", { quorum: 4 });
    expect(response.status).toBe(400);
  });
});

describe("moving it through its lifecycle", () => {
  beforeEach(async () => {
    await send("POST", "/api/campaigns", valid);
  });

  it("starts it, and says how many signups became members", async () => {
    await db(env)
      .insert(schema.users)
      .values({ discordId: "2002", username: "bob", feedToken: "t2" });
    await db(env).insert(schema.signups).values({
      targetType: "campaign_forming",
      targetId: "age-of-umbra",
      userId: "2002",
      state: "in",
    });

    const response = await send("POST", "/api/campaigns/age-of-umbra/transition", {
      to: "RUNNING",
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ from: "FORMING", to: "RUNNING", membersAdded: 1 });
    expect(await campaign()).toMatchObject({ state: "RUNNING" });
  });

  it("refuses an illegal move with the reason, not a stack trace", async () => {
    const response = await send("POST", "/api/campaigns/age-of-umbra/transition", {
      to: "CONCLUDED",
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: expect.stringContaining("FORMING → CONCLUDED"),
    });
    expect(await campaign()).toMatchObject({ state: "FORMING" });
  });

  it("wants to be told where to go", async () => {
    expect((await send("POST", "/api/campaigns/age-of-umbra/transition", {})).status).toBe(400);
  });

  it("is an organiser's to do, like every other write", async () => {
    roles = [];

    expect((await send("POST", "/api/campaigns", { ...valid, name: "Another" })).status).toBe(403);
    expect((await send("PATCH", "/api/campaigns/age-of-umbra", { quorum: 9 })).status).toBe(403);
    expect(
      (await send("POST", "/api/campaigns/age-of-umbra/transition", { to: "RUNNING" })).status,
    ).toBe(403);
  });
});

/**
 * The campaign's page: the *plan*, as against the writes above.
 *
 * Its record — what it has already played, and the flake memory counted from
 * that — is `p6/6`, and its open polls are `p6/7`. What is worth testing here is
 * the three ways a plan can be empty and still be fine: no cadence, not started,
 * and over. All three render the same blank table if nobody says which it is.
 */
async function person(id: string) {
  await db(env)
    .insert(schema.users)
    .values({
      discordId: id,
      username: id,
      globalName: `Player ${id}`,
      feedToken: `t-${id}`,
    })
    .onConflictDoNothing();
}

async function planned(
  over: Partial<typeof schema.campaigns.$inferInsert> = {},
) {
  await db(env)
    .insert(schema.campaigns)
    .values({
      id: "umbra",
      name: "Age of Umbra",
      kind: "run",
      state: "RUNNING",
      quorum: 2,
      recurrenceAnchor: seconds - 365 * 86_400,
      intervalWeeks: 2,
      discordChannelId: "chan-1",
      ...over,
    });
  for (const who of ["a", "b", "c"]) {
    await person(who);
    await db(env)
      .insert(schema.campaignMembers)
      .values({ campaignId: "umbra", userId: who });
  }
  return "umbra";
}

/** A session `days` from `NOW`. Negative is in the past. */
async function played(number: number, days: number) {
  const startsAt = seconds + days * 86_400;
  await db(env)
    .insert(schema.sessions)
    .values({
      id: `umbra-s${number}`,
      kind: "campaign_session",
      campaignId: "umbra",
      number,
      startsAt,
      endsAt: startsAt + 4 * 3600,
      location: "The Wreck",
    });
  return `umbra-s${number}`;
}

function page(asOf = NOW) {
  return campaignPage(env, "umbra", asOf);
}

describe("what is coming", () => {
  it("splits on the asOf it is given, not on the clock", async () => {
    await planned();
    await played(1, -14);
    await played(2, -1);
    await played(3, 1);
    await played(4, 30);

    // Every date in this file is a year out from any machine that runs it. A
    // split taken off `Date.now()` would pass today and fail in 2027, which is
    // the worst failure a scheduling repo can ship.
    expect((await page())!.upcoming.map((row) => row.sessionId)).toEqual([
      "umbra-s3",
      "umbra-s4",
    ]);
  });

  it("moves the split when the caller moves the instant", async () => {
    await planned();
    await played(1, -14);
    await played(2, -1);
    await played(3, 1);

    const earlier = (await page(new Date(NOW.getTime() - 20 * 86_400_000)))!;

    expect(earlier.upcoming.map((row) => row.sessionId)).toEqual([
      "umbra-s1",
      "umbra-s2",
      "umbra-s3",
    ]);
  });

  it("carries the tally and the quorum the agenda carries", async () => {
    await planned();
    const id = await played(1, 1);
    await db(env)
      .insert(schema.attendance)
      .values({ sessionId: id, userId: "a", intent: "in" });

    const row = (await page())!.upcoming[0];

    // One query behind both pages is the whole point of `p6/1`. Two pages
    // disagreeing about whether a session has quorum is worse than one of them
    // not saying.
    expect(row?.tally).toMatchObject({ in: 1, noReply: 2 });
    expect(row?.rosterSize).toBe(3);
    expect(row?.quorum).toBeDefined();
  });

  it("says a projection has not happened rather than inventing a chip", async () => {
    await planned();
    await played(1, 1);

    expect((await page())!.upcoming[0]?.sync).toEqual({
      state: "not-projected",
      syncedAt: null,
      lastError: null,
    });
  });

  it("shows the failure the projector recorded, never one it asks Google for", async () => {
    await planned();
    const id = await played(1, 1);
    await db(env)
      .insert(schema.calendarLinks)
      .values({
        sessionId: id,
        gcalEventId: "ev-1",
        syncedAt: seconds - 3600,
        lastError: "403",
      });

    expect((await page())!.upcoming[0]?.sync).toMatchObject({
      state: "failing",
      lastError: "403",
    });
  });
});

describe("an empty horizon, in words", () => {
  it("names the missing cadence rather than rendering nothing", async () => {
    await planned({ recurrenceAnchor: null, intervalWeeks: null });

    const plan = (await page())!;

    expect(plan.upcoming).toEqual([]);
    expect(plan.cadence.stated).toBe(false);
    expect(plan.upcomingNote).toContain("No cadence set");
  });

  it("counts an interval of zero as no cadence at all", async () => {
    await planned({ intervalWeeks: 0 });

    // A zero interval is a materialiser that never advances. The column carries
    // no CHECK — `campaigns` cannot be rebuilt without cascading the attendance
    // history away — so this is one of the places that has to know.
    expect((await page())!.cadence.stated).toBe(false);
  });

  it("says a forming campaign has not started, not that it has no cadence", async () => {
    await planned({ state: "FORMING" });

    expect((await page())!.upcomingNote).toContain("until the campaign starts");
  });

  it("says a hiatus is a hiatus", async () => {
    await planned({ state: "HIATUS" });

    expect((await page())!.upcomingNote).toContain("On hiatus");
  });

  it("says a campaign that has run out has run out", async () => {
    await planned({ maxSessions: 2 });
    await played(1, -14);
    await played(2, -1);

    const plan = (await page())!;

    expect(plan.remaining).toBe(0);
    expect(plan.upcomingNote).toContain("every session it was going to");
  });

  it("says nothing at all when there is something to show", async () => {
    await planned();
    await played(1, 1);

    expect((await page())!.upcomingNote).toBeNull();
  });
});

describe("where the page says it may go", () => {
  it("offers a concluded campaign nothing, and still renders it", async () => {
    await planned({ state: "CONCLUDED" });
    await played(1, -30);

    const plan = (await page())!;

    // The page is how an organiser reads what happened to a campaign. Refusing
    // to render one because it is over would put the only record of it behind a
    // database client.
    expect(plan.name).toBe("Age of Umbra");
    expect(plan.roster).toHaveLength(3);
    expect(plan.nextStates).toEqual([]);
    expect(plan.upcomingNote).toContain("concluded");
  });

  it("offers what the edge map offers, and nothing else", async () => {
    await planned();
    expect((await page())!.nextStates).toEqual(["HIATUS", "CONCLUDED"]);

    await db(env)
      .update(schema.campaigns)
      .set({ state: "FORMING" })
      .where(eq(schema.campaigns.id, "umbra"));
    expect((await page())!.nextStates).toEqual(["RUNNING"]);
  });
});

describe("who the page says is on it", () => {
  it("is the list the roster itself gives, not a second cut of it", async () => {
    await planned();

    // This slice's review focus: a roster block that diverges from the one below
    // the fork is the console disagreeing with the attendance post about who is
    // on a campaign.
    expect((await page())!.roster).toEqual(await rosterOf(env, "umbra"));
  });

  it("is the claimants while it is still forming", async () => {
    await planned({ state: "FORMING" });
    await person("d");
    await db(env)
      .insert(schema.signups)
      .values({
        targetType: "campaign_forming",
        targetId: "umbra",
        userId: "d",
        state: "in",
      });

    expect((await page())!.roster.map((row) => row.userId)).toEqual(["d"]);
  });
});

describe("the page over HTTP", () => {
  it("answers with the as-of the reading was taken at", async () => {
    await planned();
    await played(1, 1);

    const res = await send("GET", "/api/campaigns/umbra/page");
    const body = (await res.json()) as {
      asOf: number;
      campaign: { id: string };
    };

    expect(res.status).toBe(200);
    expect(body.campaign.id).toBe("umbra");
    expect(body.asOf).toBeGreaterThan(0);
  });

  it("says it does not know a campaign rather than returning an empty one", async () => {
    const res = await send("GET", "/api/campaigns/nowhere/page");

    expect(res.status).toBe(404);
    expect((await res.json()) as { error: string }).toMatchObject({
      error: expect.any(String),
    });
  });
});

/**
 * The campaign's open polls, and the one boolean beside them.
 *
 * This slice is display plus a toggle. What is worth testing is that it stays
 * that: the toggle writes one row through the same function every other campaign
 * field goes through and touches no poll, and a poll the rule already likes is
 * reported as *waiting* rather than acted on.
 */
async function opened(
  pollId: string,
  over: Partial<typeof schema.datePolls.$inferInsert> = {},
) {
  await db(env)
    .insert(schema.datePolls)
    .values({
      id: pollId,
      campaignId: "umbra",
      winRule: "min_players",
      winThreshold: 2,
      status: "open",
      discordChannelId: "chan-1",
      discordMessageId: "msg-1",
      ...over,
    });
  return pollId;
}

async function candidate(pollId: string, id: string, days: number, yeses: string[]) {
  const startsAt = seconds + days * 86_400;
  await db(env)
    .insert(schema.pollDates)
    .values({ id, pollId, startsAt, endsAt: startsAt + 4 * 3600 });
  for (const userId of yeses) {
    await person(userId);
    await db(env).insert(schema.pollResponses).values({ pollDateId: id, userId });
  }
  return id;
}

/** Somebody on the roster, optionally running it. */
async function member(userId: string, role: "gm" | "player" = "player") {
  await person(userId);
  await db(env)
    .insert(schema.campaignMembers)
    .values({ campaignId: "umbra", userId, role })
    .onConflictDoNothing();
}

describe("the open polls", () => {
  it("lists candidate dates with the yeses they have, and links to the post", async () => {
    await planned();
    await opened("p1");
    await candidate("p1", "d1", 7, ["a", "b"]);
    await candidate("p1", "d2", 14, ["a"]);

    const { polls } = await campaignPolls(env, "umbra");

    expect(polls).toHaveLength(1);
    expect(polls[0]?.dates.map((date) => date.yes)).toEqual([2, 1]);
    expect(polls[0]?.postUrl).toBe("https://discord.com/channels/g1/chan-1/msg-1");
    expect(polls[0]?.required).toBe(2);
  });

  it("says what the rule proposes without being the thing that acts on it", async () => {
    await planned();
    await member("gm", "gm");
    await opened("p1");
    await candidate("p1", "d1", 7, ["a", "b", "gm"]);

    const { polls } = await campaignPolls(env, "umbra");

    expect(polls[0]?.proposed).toEqual(["d1"]);
    // The poll is still open, and nothing on this page closed it. Canonise is an
    // organiser-only button on the post; a page load must never be the thing
    // that decides a date.
    const open = await db(env).select().from(schema.datePolls).all();
    expect(open.map((poll) => poll.status)).toEqual(["open"]);
  });

  it("is waiting on the organiser once the rule and the GM both agree", async () => {
    await planned();
    await member("gm", "gm");
    await opened("p1");
    await candidate("p1", "d1", 7, ["a", "b", "gm"]);

    expect((await campaignPolls(env, "umbra")).polls[0]?.waitingOn).toBe("organiser");
  });

  it("is waiting on the GM when the threshold is met on a night they have not marked", async () => {
    await planned();
    await member("gm", "gm");
    await opened("p1");
    await candidate("p1", "d1", 7, ["a", "b", "c"]);

    const poll = (await campaignPolls(env, "umbra")).polls[0];

    // Three players past a threshold of two, on a night the GM has not said they
    // can make. That is not a win, it is a scheduling accident — and a poll that
    // closed itself on one would have to be reopened by hand.
    expect(poll?.proposed).toEqual(["d1"]);
    expect(poll?.dates[0]?.gmAvailable).toBe(false);
    expect(poll?.waitingOn).toBe("gm");
  });

  it("is waiting on responses while the rule proposes nothing", async () => {
    await planned();
    await member("gm", "gm");
    await opened("p1");
    await candidate("p1", "d1", 7, ["a"]);

    const poll = (await campaignPolls(env, "umbra")).polls[0];
    expect(poll?.proposed).toEqual([]);
    expect(poll?.waitingOn).toBe("responses");
  });

  it("says nobody was asked rather than that the GM said no", async () => {
    await planned();
    await opened("p1");
    await candidate("p1", "d1", 7, ["a", "b"]);

    // A campaign with no GM is a real state. Rendering `false` would read as a
    // refusal by somebody who does not exist.
    expect((await campaignPolls(env, "umbra")).polls[0]?.dates[0]?.gmAvailable).toBeNull();
  });

  it("lists no closed poll", async () => {
    await planned();
    await opened("p1", { status: "closed" });
    await candidate("p1", "d1", 7, ["a", "b"]);

    expect((await campaignPolls(env, "umbra")).polls).toEqual([]);
  });
});

describe("the auto-resolve toggle", () => {
  it("writes exactly one audit row and touches no open poll", async () => {
    await planned();
    await opened("p1");
    await candidate("p1", "d1", 7, ["a", "b", "c"]);

    const res = await send("PATCH", "/api/campaigns/umbra", { autoResolvePolls: true });

    expect(res.status).toBe(200);
    expect((await campaignPolls(env, "umbra")).autoResolvePolls).toBe(true);

    // One row, through the same `updateCampaign` every other campaign field goes
    // through. A second write path for one boolean is a second thing to review.
    const rows = await audit();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: "campaign.update", targetId: "umbra" });

    // Turning it on is a statement about the *next* click, not about the polls
    // already open. Nothing here closed, canonised or re-decided one.
    const polls = await db(env).select().from(schema.datePolls).all();
    expect(polls.map((poll) => poll.status)).toEqual(["open"]);
    const dates = await db(env).select().from(schema.pollDates).all();
    expect(dates.map((date) => date.outcome)).toEqual(["open"]);
  });

  it("turns off again, and is read live rather than copied onto a poll", async () => {
    await planned({ autoResolvePolls: 1 });
    await opened("p1");

    await send("PATCH", "/api/campaigns/umbra", { autoResolvePolls: false });

    // An organiser who turns it off expects the next click to respect that, not
    // the next poll. Nothing copies the flag onto `date_polls`, and this is what
    // would fail if something started.
    expect((await campaignPolls(env, "umbra")).autoResolvePolls).toBe(false);
  });
});

describe("the polls over HTTP", () => {
  it("answers with the flag and the list together", async () => {
    await planned({ autoResolvePolls: 1 });
    await opened("p1");
    await candidate("p1", "d1", 7, ["a"]);

    const res = await send("GET", "/api/campaigns/umbra/polls");
    const body = (await res.json()) as Awaited<ReturnType<typeof campaignPolls>>;

    expect(res.status).toBe(200);
    expect(body.autoResolvePolls).toBe(true);
    expect(body.polls[0]?.pollId).toBe("p1");
  });
});
