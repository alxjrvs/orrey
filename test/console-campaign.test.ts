import { env } from "cloudflare:test";
import { asc, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db, schema } from "../src/db/index.ts";
import { SETTING_KEYS, setSetting } from "../src/db/settings.ts";
import { createApp } from "../src/http/app.ts";
import { SESSION_COOKIE, issueSession } from "../src/console/cookies.ts";

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
  return `${SESSION_COOKIE}=${await issueSession(consoleEnv(), "1001", NOW)}`;
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
  await db(env)
    .insert(schema.discordTokens)
    .values({ userId: "1001", accessToken: "at", refreshToken: "rt", expiresAt: seconds + 86_400 });
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
