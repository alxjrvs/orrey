import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { db, schema } from "../src/db/index.ts";
import { SETTING_KEYS, setSetting } from "../src/db/settings.ts";
import { createApp } from "../src/http/app.ts";
import { eventIdFor } from "../src/google/event-id.ts";

/**
 * Two feeds, one token.
 *
 * The token in the path is the only credential, because a calendar client cannot
 * log in. That makes the shape of a refusal the most important thing here: an
 * unknown token and a real token asking for somebody else's campaign have to be
 * the same answer, byte for byte, or trying tokens tells you which ones are real.
 */
const app = createApp();
const START = Math.floor(Date.parse("2026-09-20T18:00:00Z") / 1000);

function get(path: string) {
  return app.fetch(new Request(`https://orrey.test${path}`), env as never);
}

async function person(id: string, token: string) {
  await db(env)
    .insert(schema.users)
    .values({ discordId: id, username: id, globalName: `Player ${id}`, feedToken: token })
    .onConflictDoNothing();
}

async function campaign(id: string, name: string, members: string[]) {
  await db(env).insert(schema.campaigns).values({ id, name, kind: "run", state: "RUNNING" });
  for (const userId of members) {
    await db(env).insert(schema.campaignMembers).values({ campaignId: id, userId });
  }
}

async function session(id: string, campaignId: string, days: number, state = "SCHEDULED") {
  const startsAt = START + days * 86_400;
  await db(env)
    .insert(schema.sessions)
    .values({
      id,
      kind: "campaign_session",
      campaignId,
      number: 1,
      startsAt,
      endsAt: startsAt + 4 * 3600,
      location: "The Wreck",
      state: state as "SCHEDULED",
    });
  return id;
}

/** UIDs, as a client would read them out of the file. */
function uidsIn(text: string): string[] {
  return text
    .split("\r\n")
    .filter((line) => line.startsWith("UID:"))
    .map((line) => line.slice(4));
}

beforeEach(async () => {
  for (const table of [
    "attendance",
    "signups",
    "campaign_members",
    "sessions",
    "game_days",
    "games",
    "campaigns",
    "users",
    "settings",
  ]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  await setSetting(env, SETTING_KEYS.guildId, "g1");
  await setSetting(env, SETTING_KEYS.timezone, "Europe/London");
});

describe("the refusal", () => {
  it("is byte-identical for an unknown token and for somebody else's campaign", async () => {
    await person("ada", "tok-ada");
    await person("bea", "tok-bea");
    await campaign("umbra", "Age of Umbra", ["bea"]);

    const unknown = await get("/ics/tok-nobody/all.ics");
    const notMine = await get("/ics/tok-ada/campaign/umbra.ics");

    // A 401 here, or a different body, would confirm which tokens are real to
    // whoever is trying them.
    expect(unknown.status).toBe(404);
    expect(notMine.status).toBe(404);
    expect(await unknown.text()).toBe(await notMine.text());
    expect(await unknown.text()).toBe("");
  });

  it("asks for no cookie and reads none", async () => {
    await person("ada", "tok-ada");
    await campaign("umbra", "Age of Umbra", ["ada"]);
    await session("s1", "umbra", 0);

    // The console's session middleware would 401 this. These routes sit above
    // it on purpose: a calendar client cannot log in.
    const res = await app.fetch(
      new Request("https://orrey.test/ics/tok-ada/all.ics", { headers: { cookie: "nonsense=1" } }),
      env as never,
    );

    expect(res.status).toBe(200);
  });
});

describe("what is in it", () => {
  it("is the holder's campaigns and nobody else's", async () => {
    await person("ada", "tok-ada");
    await person("bea", "tok-bea");
    await campaign("umbra", "Age of Umbra", ["ada"]);
    await campaign("deeps", "The Deeps", ["bea"]);
    await session("mine", "umbra", 0);
    await session("theirs", "deeps", 1);

    const text = await (await get("/ics/tok-ada/all.ics")).text();

    expect(uidsIn(text)).toEqual([`${await eventIdFor("mine")}@orrey`]);
  });

  it("narrows to one campaign, and drops the game days with it", async () => {
    await person("ada", "tok-ada");
    await campaign("umbra", "Age of Umbra", ["ada"]);
    await campaign("deeps", "The Deeps", ["ada"]);
    await session("umbra-1", "umbra", 0);
    await session("deeps-1", "deeps", 1);
    await day("day-1", "ada");

    expect(uidsIn(await (await get("/ics/tok-ada/all.ics")).text())).toHaveLength(3);
    expect(uidsIn(await (await get("/ics/tok-ada/campaign/umbra.ics")).text())).toEqual([
      `${await eventIdFor("umbra-1")}@orrey`,
    ]);
  });

  it("carries the game days the holder has claimed a seat on", async () => {
    await person("ada", "tok-ada");
    await campaign("umbra", "Age of Umbra", ["ada"]);
    await day("day-1", "ada");

    expect(uidsIn(await (await get("/ics/tok-ada/all.ics")).text())).toEqual([
      `${await eventIdFor("gd-day-1")}@orrey`,
    ]);
  });

  it("leaves out a day the holder withdrew from", async () => {
    await person("ada", "tok-ada");
    await campaign("umbra", "Age of Umbra", ["ada"]);
    await day("day-1", "ada", "out");

    // A day somebody left should leave their calendar, and it does because the
    // event is simply not emitted.
    expect(uidsIn(await (await get("/ics/tok-ada/all.ics")).text())).toEqual([]);
  });

  it("keeps a cancelled session, marked cancelled", async () => {
    await person("ada", "tok-ada");
    await campaign("umbra", "Age of Umbra", ["ada"]);
    await session("off", "umbra", 0, "CANCELLED");

    const text = await (await get("/ics/tok-ada/all.ics")).text();

    // Dropping it would leave the event in the subscriber's calendar for ever.
    expect(uidsIn(text)).toHaveLength(1);
    expect(text).toContain("STATUS:CANCELLED");
  });

  it("is one VCALENDAR, however many events are in it", async () => {
    await person("ada", "tok-ada");
    await campaign("umbra", "Age of Umbra", ["ada"]);
    await session("s1", "umbra", 0);
    await session("s2", "umbra", 7);

    const text = await (await get("/ics/tok-ada/all.ics")).text();

    expect(text.match(/BEGIN:VCALENDAR/g)).toHaveLength(1);
    expect(text.match(/END:VCALENDAR/g)).toHaveLength(1);
    expect(text.match(/BEGIN:VEVENT/g)).toHaveLength(2);
    expect(text.trimEnd().endsWith("END:VCALENDAR")).toBe(true);
  });

  it("answers an empty calendar rather than a 404 for somebody on nothing", async () => {
    await person("ada", "tok-ada");

    const res = await get("/ics/tok-ada/all.ics");

    // The token is real, so the feed exists; it simply has nothing in it yet.
    // A 404 here would tell a subscriber their URL had stopped working.
    expect(res.status).toBe(200);
    expect(uidsIn(await res.text())).toEqual([]);
  });
});

describe("the path", () => {
  it("refuses a campaign file that is not an .ics", async () => {
    await person("ada", "tok-ada");
    await campaign("umbra", "Age of Umbra", ["ada"]);

    // Hono reads `:id.ics` as a parameter *named* `id.ics`, so the extension is
    // stripped in the handler instead. This is what proves it is checked at all.
    expect((await get("/ics/tok-ada/campaign/umbra")).status).toBe(404);
    expect((await get("/ics/tok-ada/campaign/umbra.ics")).status).toBe(200);
  });
});

describe("the headers", () => {
  it("say text/calendar, and keep the response out of shared caches", async () => {
    await person("ada", "tok-ada");
    await campaign("umbra", "Age of Umbra", ["ada"]);
    await session("s1", "umbra", 0);

    const res = await get("/ics/tok-ada/all.ics");

    expect(res.headers.get("content-type")).toBe("text/calendar; charset=utf-8");
    // `private`, because the token is in the path: a shared cache holding this
    // response is a shared cache holding the credential.
    expect(res.headers.get("cache-control")).toBe("private, max-age=900");
  });
});

/** A game day, its session, and a signup on the day — never on the session. */
async function day(id: string, userId: string, state: "in" | "out" = "in") {
  await db(env)
    .insert(schema.gameDays)
    .values({ id, kind: "single", state: "SEATING", startsAt: START, endsAt: START + 4 * 3600 });
  await db(env)
    .insert(schema.sessions)
    .values({
      id: `gd-${id}`,
      kind: "one_off",
      gameDayId: id,
      startsAt: START,
      endsAt: START + 4 * 3600,
    });
  await db(env)
    .insert(schema.signups)
    .values({ targetType: "game_day", targetId: id, userId, state, position: 1 });
}
