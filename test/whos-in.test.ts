import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { db, schema } from "../src/db/index.ts";
import { createApp } from "../src/http/app.ts";
import { InteractionResponseType, InteractionType } from "../src/discord/types.ts";
import { fakeDiscord } from "./discord.ts";
import { MAX_CHOICES, renderWhosIn, sessionChoices, whosIn } from "../src/commands/whos-in.ts";
import { ENOUGH } from "../src/campaigns/flake.ts";

/**
 * The authoritative roster. This command exists because posts are snapshots, so
 * everything here is really one question: is the answer read from D1 now, and is
 * it only ever the caller's own campaign.
 */
const discord = await fakeDiscord();
const app = createApp();
const ASOF = new Date("2026-09-14T12:00:00Z");
const NOW = Math.floor(ASOF.getTime() / 1000);
const DAY = 86_400;

async function campaign(id: string, name: string) {
  await db(env).insert(schema.campaigns).values({ id, name, kind: "run", state: "RUNNING" });
}

async function person(id: string, name: string) {
  await db(env)
    .insert(schema.users)
    .values({ discordId: id, username: id, globalName: name, feedToken: `t-${id}` })
    .onConflictDoNothing();
}

async function member(
  campaignId: string,
  userId: string,
  name: string,
  role: "gm" | "player" = "player",
) {
  await person(userId, name);
  await db(env)
    .insert(schema.campaignMembers)
    .values({ campaignId, userId, role, joinedAt: NOW - 365 * DAY });
}

// `inDays` counts from `ASOF` because most tests here hand `ASOF` to the thing
// they are testing, and a frozen pair keeps the rendered timestamps assertable.
// A test that goes through `app.fetch` gets no such say: the route reads the
// real clock, so it passes `REAL_NOW` and the seeded session is upcoming today
// as well as on the day this was written.
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

async function said(
  sessionId: string,
  userId: string,
  intent: "in" | "out" | "maybe" | null,
  note: string | null = null,
) {
  await db(env).insert(schema.attendance).values({ sessionId, userId, intent, note });
}

function command(userId: string, options?: { name: string; value: string }[]) {
  return discord.request({
    type: InteractionType.APPLICATION_COMMAND,
    data: { name: "whos-in", ...(options ? { options } : {}) },
    member: { user: { id: userId, username: userId, global_name: null }, roles: [] },
    guild_id: "g",
  });
}

beforeEach(async () => {
  for (const table of ["attendance", "campaign_members", "jobs", "sessions", "campaigns", "users"]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
});

describe("which session it answers about", () => {
  it("the caller's next one, when they name none", async () => {
    await campaign("umbra", "Age of Umbra");
    await member("umbra", "ada", "Ada");
    await session("umbra", 1, 14);
    await session("umbra", 2, 3);

    const answer = await whosIn(env, "ada", undefined, ASOF);
    expect(answer).toMatchObject({ sessionId: "umbra-s2" });
  });

  it("the one they named", async () => {
    await campaign("umbra", "Age of Umbra");
    await member("umbra", "ada", "Ada");
    await session("umbra", 1, 3);
    await session("umbra", 2, 14);

    expect(await whosIn(env, "ada", "umbra-s2", ASOF)).toMatchObject({ sessionId: "umbra-s2" });
  });

  it("refuses a session on a campaign they are not on", async () => {
    await campaign("secret", "Somebody Else's Game");
    await member("secret", "bo", "Bo");
    await session("secret", 1, 3);
    await person("ada", "Ada");

    // The autocomplete only ever offers your own campaigns, but a person can
    // type any id they like — so the refusal is here, not in the suggestions.
    expect(await whosIn(env, "ada", "secret-s1", ASOF)).toBe("not-yours");
  });

  it("says there is nothing rather than failing", async () => {
    await person("ada", "Ada");
    expect(await whosIn(env, "ada", undefined, ASOF)).toBe("no-session");
    expect(await whosIn(env, "ada", "no-such-session", ASOF)).toBe("no-session");
  });
});

describe("what it says", () => {
  it("groups the whole roster, including people who have said nothing", async () => {
    await campaign("umbra", "Age of Umbra");
    await member("umbra", "gm-1", "Gwen", "gm");
    await member("umbra", "ada", "Ada");
    await member("umbra", "bo", "Bo");
    await member("umbra", "cy", "Cy");
    const id = await session("umbra", 1, 3);
    await said(id, "gm-1", "in");
    await said(id, "ada", "in");
    await said(id, "bo", "out");

    const answer = await whosIn(env, "ada", id, ASOF);
    if (typeof answer === "string") throw new Error(answer);

    // Cy is on the roster and has said nothing. A roster that only listed the
    // people who clicked would answer a different question.
    expect(answer.rows).toHaveLength(4);
    expect(answer.rows.find((row) => row.userId === "cy")).toMatchObject({ intent: null });

    const content = renderWhosIn(answer, ASOF);
    expect(content).toContain("**In** — 2");
    expect(content).toContain("**Out** — 1");
    expect(content).toContain("**Not heard from** — 1");
    expect(content).toContain("**Gwen** (GM)");
  });

  it("is read from D1, not from whatever the post last said", async () => {
    await campaign("umbra", "Age of Umbra");
    await member("umbra", "ada", "Ada");
    const id = await session("umbra", 1, 3);
    await said(id, "ada", "out");
    // The post, wherever it is, still says "out". D1 does not.
    await env.DB.prepare("UPDATE attendance SET intent = 'in'").run();

    const answer = await whosIn(env, "ada", id, ASOF);
    if (typeof answer === "string") throw new Error(answer);
    expect(answer.rows[0]).toMatchObject({ intent: "in" });
    expect(renderWhosIn(answer, ASOF)).toContain(`<t:${NOW}:t>`);
  });

  it("carries notes", async () => {
    await campaign("umbra", "Age of Umbra");
    await member("umbra", "ada", "Ada");
    const id = await session("umbra", 1, 3);
    await said(id, "ada", "in", "Running 30 late");

    const answer = await whosIn(env, "ada", id, ASOF);
    if (typeof answer === "string") throw new Error(answer);
    expect(renderWhosIn(answer, ASOF)).toContain("Running 30 late");
  });

  it("shows flake only where there is enough history to mean anything", async () => {
    await campaign("umbra", "Age of Umbra");
    await member("umbra", "ada", "Ada");
    await member("umbra", "bo", "Bo");
    for (let n = 1; n <= ENOUGH; n++) {
      const past = await session("umbra", n, -30 + n, "PLAYED");
      await db(env)
        .insert(schema.attendance)
        .values({ sessionId: past, userId: "ada", intent: "in", attended: n === 1 ? 0 : 1 });
    }
    const id = await session("umbra", 99, 3);

    const answer = await whosIn(env, "ada", id, ASOF);
    if (typeof answer === "string") throw new Error(answer);

    expect(answer.rows.find((row) => row.userId === "ada")?.flake).toContain(
      `came to ${ENOUGH - 1} of ${ENOUGH}`,
    );
    // Bo has no history. No number is the honest answer, not 0%.
    expect(answer.rows.find((row) => row.userId === "bo")?.flake).toBeUndefined();
  });
});

describe("autocomplete", () => {
  it("offers only the caller's own upcoming sessions", async () => {
    await campaign("umbra", "Age of Umbra");
    await campaign("secret", "Somebody Else's Game");
    await member("umbra", "ada", "Ada");
    await member("secret", "bo", "Bo");
    await session("umbra", 1, 3);
    await session("secret", 1, 1);
    await session("umbra", 2, -1);
    await session("umbra", 3, 5, "CANCELLED");

    const choices = await sessionChoices(env, "ada", "", ASOF);
    expect(choices.map((choice) => choice.value)).toEqual(["umbra-s1"]);
  });

  it("never offers more than Discord accepts", async () => {
    await campaign("umbra", "Age of Umbra");
    await member("umbra", "ada", "Ada");
    for (let n = 1; n <= MAX_CHOICES + 10; n++) await session("umbra", n, n);

    expect(await sessionChoices(env, "ada", "", ASOF)).toHaveLength(MAX_CHOICES);
  });

  it("filters by what has been typed", async () => {
    await campaign("umbra", "Age of Umbra");
    await campaign("deeps", "The Deeps");
    await member("umbra", "ada", "Ada");
    await member("deeps", "ada", "Ada");
    await session("umbra", 1, 3);
    await session("deeps", 1, 4);

    expect((await sessionChoices(env, "ada", "deeps", ASOF)).map((c) => c.value)).toEqual([
      "deeps-s1",
    ]);
  });

  it("answers the interaction with choices rather than an empty list", async () => {
    await campaign("umbra", "Age of Umbra");
    await member("umbra", "ada", "Ada");
    await session("umbra", 4, 3, "SCHEDULED", REAL_NOW());

    const res = await app.fetch(
      await discord.request({
        type: InteractionType.APPLICATION_COMMAND_AUTOCOMPLETE,
        data: { name: "whos-in", options: [{ name: "event", value: "", focused: true }] },
        member: { user: { id: "ada", username: "ada", global_name: null }, roles: [] },
        guild_id: "g",
      }),
      discord.env(env),
    );

    const json = (await res.json()) as { type: number; data: { choices: { value: string }[] } };
    expect(json.type).toBe(InteractionResponseType.APPLICATION_COMMAND_AUTOCOMPLETE_RESULT);
    expect(json.data.choices.map((choice) => choice.value)).toEqual(["umbra-s4"]);
  });
});

describe("the command", () => {
  it("answers ephemerally and writes nothing", async () => {
    await campaign("umbra", "Age of Umbra");
    await member("umbra", "ada", "Ada");
    const id = await session("umbra", 1, 3, "SCHEDULED", REAL_NOW());
    await said(id, "ada", "in");

    const res = await app.fetch(await command("ada"), discord.env(env));
    const json = (await res.json()) as { data: { content: string; flags: number } };

    expect(json.data.flags & 64).toBeTruthy();
    expect(json.data.content).toContain("Age of Umbra — Session 1");
    expect(json.data.content).not.toContain("arrive in phase 2");

    expect(await db(env).select().from(schema.jobs).all()).toEqual([]);
    expect(await db(env).select().from(schema.attendance).all()).toHaveLength(1);
  });

  it("refuses somebody else's session in the response, not just the suggestions", async () => {
    await campaign("secret", "Somebody Else's Game");
    await member("secret", "bo", "Bo");
    await session("secret", 1, 3);
    await person("ada", "Ada");

    const res = await app.fetch(
      await command("ada", [{ name: "event", value: "secret-s1" }]),
      discord.env(env),
    );
    expect(((await res.json()) as { data: { content: string } }).data.content).toContain(
      "not on a campaign you are on",
    );
  });
});

describe("somebody else's text, on a message Orrey cannot edit", () => {
  it("escapes names, character names and notes", async () => {
    await campaign("umbra", "Age of **Umbra**");
    await member("umbra", "ada", "**Out (4)** — Everyone");
    const id = await session("umbra", 1, 3);
    await said(id, "ada", "in", "`reflow` *everything*");
    await db(env)
      .update(schema.campaignMembers)
      .set({ characterName: "__Vex__" })
      .where(eq(schema.campaignMembers.userId, "ada"));

    const answer = await whosIn(env, "ada", id, ASOF);
    if (typeof answer === "string") throw new Error(answer);
    const content = renderWhosIn(answer, ASOF);

    // On the command that exists to be authoritative, a note that reformats the
    // roster is the worst place in the repo for it.
    expect(content).toContain("\\*\\*Out (4)\\*\\*");
    expect(content).toContain("\\`reflow\\`");
    expect(content).toContain("\\_\\_Vex\\_\\_");
    expect(content).toContain("Age of \\*\\*Umbra\\*\\*");
  });
});

describe("a roster too big to send", () => {
  it("shortens rather than being rejected outright", async () => {
    await campaign("umbra", "Age of Umbra");
    const id = await session("umbra", 1, 3);
    for (let i = 0; i < 120; i++) {
      await member("umbra", `p${i}`, `A Player With A Rather Long Display Name ${i}`);
      await said(id, `p${i}`, "in", `and a note that goes on for a while too ${i}`);
    }

    const answer = await whosIn(env, "p0", id, ASOF);
    if (typeof answer === "string") throw new Error(answer);
    const content = renderWhosIn(answer, ASOF);

    // An interaction response over Discord's ceiling is not a shortened answer,
    // it is no answer: the call is rejected outright.
    expect(content.length).toBeLessThanOrEqual(1900);
    // The counts are the part that must survive.
    expect(content).toContain("**In** — 120");
    expect(content).toContain("not from any post");
  });
});

describe("autocomplete past the first twenty-five", () => {
  it("finds a session the typed text names, however far out it is", async () => {
    await campaign("umbra", "Age of Umbra");
    await campaign("deeps", "The Deeps");
    await member("umbra", "ada", "Ada");
    await member("deeps", "ada", "Ada");
    for (let n = 1; n <= MAX_CHOICES + 5; n++) await session("umbra", n, n);
    await session("deeps", 1, 100);

    const choices = await sessionChoices(env, "ada", "deeps", ASOF);

    // Filtering after the LIMIT means the twenty-sixth-soonest session can never
    // be picked however precisely somebody types its name — which is exactly
    // when they would be typing.
    expect(choices.map((choice) => choice.value)).toEqual(["deeps-s1"]);
  });

  it("still offers the soonest when nothing has been typed", async () => {
    await campaign("umbra", "Age of Umbra");
    await member("umbra", "ada", "Ada");
    for (let n = 1; n <= MAX_CHOICES + 5; n++) await session("umbra", n, n);

    expect(await sessionChoices(env, "ada", "", ASOF)).toHaveLength(MAX_CHOICES);
  });
});
