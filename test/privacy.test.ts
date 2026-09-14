import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/http/app.ts";
import { deleteUserData, describeReceipt } from "../src/privacy/delete.ts";
import { SESSION_COOKIE, issueSession } from "../src/console/cookies.ts";
import { seedStatements } from "../src/db/seed-sql.ts";
import { encodeCustomId } from "../src/discord/custom-id.ts";
import { InteractionResponseType, InteractionType } from "../src/discord/types.ts";
import { fakeDiscord } from "./discord.ts";

const discord = await fakeDiscord();
const app = createApp();

interface Response4Or7 {
  type: number;
  data: { content: string; components?: { components: { custom_id: string }[] }[] };
}

async function interact(body: unknown): Promise<Response4Or7> {
  const res = await app.fetch(await discord.request(body), discord.env(env));
  expect(res.status).toBe(200);
  return (await res.json()) as Response4Or7;
}

function click(customId: string, userId = "1001") {
  return interact({
    type: InteractionType.MESSAGE_COMPONENT,
    data: { custom_id: customId, component_type: 2 },
    member: { user: { id: userId, username: "ada" }, roles: [] },
    message: { id: "m1", channel_id: "c1" },
  });
}

async function seedUser(discordId: string) {
  await env.DB.prepare("INSERT INTO users (discord_id, username, feed_token) VALUES (?, ?, ?)")
    .bind(discordId, `user-${discordId}`, `token-${discordId}`)
    .run();
}

async function userCount(discordId: string) {
  const row = await env.DB.prepare("SELECT count(*) AS n FROM users WHERE discord_id = ?")
    .bind(discordId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM users").run();
});

describe("the privacy policy page", () => {
  it("serves the policy at /privacy, not the console shell", async () => {
    const res = await app.fetch(new Request("https://orrey.test/privacy"), env);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toMatch(/What the Orrey knows about you/);
    // The things Discord's terms require it to name.
    for (const stored of [/Discord user id/, /feed token/i, /Delete my data/]) {
      expect(html).toMatch(stored);
    }
  });

  it("refuses an unauthenticated HTTP delete and says where the real one is", async () => {
    const res = await app.fetch(
      new Request("https://orrey.test/me", { method: "DELETE" }),
      env,
    );
    expect(res.status).toBe(405);
    expect(await res.text()).toMatch(/\/console/);
  });
});

describe("delete-my-data", () => {
  it("hands out a login link that the front door actually accepts", async () => {
    const json = await interact({
      type: InteractionType.APPLICATION_COMMAND,
      data: { name: "console" },
      member: { user: { id: "1001", username: "ada" }, roles: [] },
    });

    const link = json.data.content.match(/<(https:\/\/orrey\.test\/console\/login\?t=[^>]+)>/)?.[1];
    expect(link).toBeTruthy();

    // The command and the route agree, which is the only thing worth asserting
    // about a signed token: it is not a string that merely looks right.
    const response = await app.fetch(
      new Request(link!, { redirect: "manual" }),
      discord.env(env),
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toContain("discord.com/oauth2/authorize");
  });

  it("offers the delete button on /console, with a link to the policy", async () => {
    const json = await interact({
      type: InteractionType.APPLICATION_COMMAND,
      data: { name: "console" },
      member: { user: { id: "1001", username: "ada" }, roles: [] },
    });
    expect(json.data.content).toMatch(/https:\/\/orrey\.test\/privacy/);
    expect(json.data.components?.[0]?.components?.[0]?.custom_id).toBe("o1:privacy:delete");
  });

  it("asks once before deleting, and keeps the data if told to", async () => {
    await seedUser("1001");

    const confirm = await click(encodeCustomId({ action: "privacy", arg: "delete" }));
    expect(confirm.type).toBe(InteractionResponseType.UPDATE_MESSAGE);
    expect(confirm.data.content).toMatch(/cannot be undone/);
    expect(await userCount("1001")).toBe(1);

    const kept = await click(encodeCustomId({ action: "privacy", arg: "cancel" }));
    expect(kept.data.content).toMatch(/Nothing deleted/);
    expect(await userCount("1001")).toBe(1);
  });

  it("deletes the clicker's row on confirm, and reports what went", async () => {
    await seedUser("1001");
    await seedUser("2002");

    const done = await click(encodeCustomId({ action: "privacy", arg: "confirm" }), "1001");
    expect(done.type).toBe(InteractionResponseType.UPDATE_MESSAGE);
    expect(done.data.content).toMatch(/users \(1\)/);

    expect(await userCount("1001")).toBe(0);
    // Nobody else's data moves.
    expect(await userCount("2002")).toBe(1);
  });

  it("is honest when Orrey held nothing", async () => {
    const done = await click(encodeCustomId({ action: "privacy", arg: "confirm" }), "3003");
    expect(done.data.content).toMatch(/held no data/);
  });

  it("counts every user-keyed table, so a later phase cannot silently skip one", async () => {
    await seedUser("1001");

    // Phase 1's table. It cascades off the user row either way — what is being
    // tested is that the receipt says so, because a receipt that undercounts is
    // how a later phase's table goes unnoticed.
    for (const statement of seedStatements(
      { name: "Age of Umbra", kind: "run" },
      {
        number: 12,
        startsAt: Date.parse("2026-09-20T19:00:00Z") / 1000,
        endsAt: Date.parse("2026-09-20T23:00:00Z") / 1000,
        location: "The Wreck",
      },
    )) {
      await env.DB.prepare(statement).run();
    }
    await env.DB.prepare(
      "INSERT INTO attendance (session_id, user_id, intent, note) VALUES ('age-of-umbra-s12', '1001', 'in', 'bringing snacks')",
    ).run();

    // Phase 2's two. This test is the reason they are not missed: it names the
    // table set, so adding one without adding its delete fails here.
    await env.DB.prepare(
      "INSERT INTO campaign_members (campaign_id, user_id, role, character_name) VALUES ('age-of-umbra', '1001', 'player', 'Hollow')",
    ).run();
    await env.DB.prepare(
      "INSERT INTO signups (target_type, target_id, user_id, state) VALUES ('campaign_forming', 'age-of-umbra', '1001', 'in')",
    ).run();

    // The console's token pair. The most sensitive row Orrey holds, and the one
    // whose deletion has an effect outside Orrey.
    await env.DB.prepare(
      "INSERT INTO discord_tokens (user_id, access_token, refresh_token, expires_at) VALUES ('1001', 'a', 'r', 1)",
    ).run();

    await env.DB.prepare(
      "INSERT INTO session_logs (session_id, author, body) VALUES ('age-of-umbra-s12', '1001', 'a recap')",
    ).run();

    const receipt = await deleteUserData(env, "1001");
    expect(Object.keys(receipt.removed).sort()).toEqual([
      "attendance",
      "campaign_members",
      "discord_tokens",
      "session_logs",
      "signups",
      "users",
    ]);
    expect(receipt.removed).toEqual({
      users: 1,
      attendance: 1,
      campaign_members: 1,
      signups: 1,
      discord_tokens: 1,
      session_logs: 1,
    });

    for (const table of [
      "attendance",
      "campaign_members",
      "signups",
      "discord_tokens",
      "session_logs",
    ]) {
      const left = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>();
      expect(left?.n, table).toBe(0);
    }
  });

  it("forgets the person in the audit log without erasing what happened", async () => {
    await seedUser("1001");
    await env.DB.prepare(
      "INSERT INTO audit_log (id, actor_user_id, action, target_type, target_id) VALUES ('a1', '1001', 'campaign.conclude', 'campaign', 'age-of-umbra')",
    ).run();

    await deleteUserData(env, "1001");

    // The actor is `set null` on delete: the person is forgotten, the fact that
    // the campaign was concluded is not. Deleting the entry outright would erase
    // somebody else's history as well as their own.
    const row = await env.DB.prepare("SELECT actor_user_id, action FROM audit_log WHERE id = 'a1'")
      .first<{ actor_user_id: string | null; action: string }>();
    expect(row).toMatchObject({ actor_user_id: null, action: "campaign.conclude" });
  });
});

/**
 * The console half of the path, which is the half a person can actually reach.
 *
 * The deleted id comes from the session cookie and from nowhere else. An
 * endpoint that accepts an id is an endpoint that erases somebody else's data,
 * which is precisely why phase 0 left `DELETE /me` at 405 rather than
 * implementing it — and that 405 stays.
 */
describe("delete my data, from the console", () => {
  const NOW = new Date("2026-09-14T12:00:00Z");

  function consoleEnv() {
    return {
      ...env,
      CONSOLE_SESSION_SECRET: "a-secret",
      DISCORD_APPLICATION_ID: "app-1",
      DISCORD_CLIENT_SECRET: "shh",
      DISCORD_BOT_TOKEN: "bot-token",
    };
  }

  /**
   * A signed-in person: the user row and the token pair the cookie is checked
   * against. `sessionFrom` asks both — the cookie says who, `discord_tokens`
   * says whether Orrey can still act as them.
   */
  async function signedIn(discordId: string) {
    await seedUser(discordId);
    await env.DB.prepare(
      "INSERT INTO discord_tokens (user_id, access_token, refresh_token, expires_at) VALUES (?, 'at', 'rt', ?)",
    )
      .bind(discordId, Math.floor(Date.now() / 1000) + 86_400)
      .run();
  }

  async function deleteMe(userId: string | null, body?: unknown) {
    return app.fetch(
      new Request("https://orrey.test/console/me/delete", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(userId
            ? { cookie: `${SESSION_COOKIE}=${await issueSession(consoleEnv(), userId, new Date())}` }
            : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
      consoleEnv(),
    );
  }

  it("deletes only the caller's rows, whatever id the body names", async () => {
    await signedIn("1001");
    await signedIn("2002");

    const res = await deleteMe("1001", { discordId: "2002", userId: "2002" });

    expect(res.status).toBe(200);
    // The body is not read at all. If it were, this is the request that would
    // erase somebody else.
    expect(await userCount("1001")).toBe(0);
    expect(await userCount("2002")).toBe(1);
  });

  it("says back what it held, table by table", async () => {
    await signedIn("1001");

    const body = (await (await deleteMe("1001")).json()) as {
      receipt: { removed: Record<string, number> };
      said: string;
    };

    // The counts come from `src/privacy/delete.ts`, which is where every phase
    // that adds a user-keyed table adds its own delete and its own count. Phase
    // 6 added none; phase 7 adds `session_logs`.
    expect(Object.keys(body.receipt.removed).sort()).toEqual([
      "attendance",
      "campaign_members",
      "discord_tokens",
      "session_logs",
      "signups",
      "users",
    ]);
    expect(body.said).toContain("users (1)");
  });

  it("says Orrey held nothing rather than erroring, when there is nothing", async () => {
    await signedIn("1001");
    await deleteMe("1001");

    // The receipt for somebody Orrey holds nothing about is zeroes and a
    // sentence, not a failure. Reaching it through the console a second time is
    // not possible — the token pair the cookie is checked against went with
    // everything else — so this asks the function the route calls.
    expect(describeReceipt(await deleteUserData(env, "1001"))).toContain("no data for you");
  });

  it("stops recognising the session, because the pair it checked is gone", async () => {
    await signedIn("1001");
    await deleteMe("1001");

    // Not an error: a 401 here is Orrey correctly not knowing somebody it holds
    // nothing about. The pair stopping working immediately is the point of
    // deleting it.
    expect((await deleteMe("1001")).status).toBe(401);
  });

  it("clears the cookie, because the row it authenticated is gone", async () => {
    await signedIn("1001");

    const res = await deleteMe("1001");

    // A console that goes on greeting somebody it holds nothing about is a
    // console disagreeing with its own receipt.
    expect(res.headers.get("set-cookie")).toContain(`${SESSION_COOKIE}=`);
    expect(res.headers.get("set-cookie")).toMatch(/Max-Age=0|Expires=/i);
  });

  it("refuses without a session, and deletes nothing", async () => {
    await signedIn("1001");

    expect((await deleteMe(null, { discordId: "1001" })).status).toBe(401);
    expect(await userCount("1001")).toBe(1);
  });

  it("leaves DELETE /me answering 405 and pointing at the console", async () => {
    await signedIn("1001");

    const res = await app.fetch(
      new Request("https://orrey.test/me", { method: "DELETE" }),
      consoleEnv(),
    );

    expect(res.status).toBe(405);
    expect(await userCount("1001")).toBe(1);
  });
});
