import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/http/app.ts";
import { deleteUserData } from "../src/privacy/delete.ts";
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

    const receipt = await deleteUserData(env, "1001");
    expect(Object.keys(receipt.removed).sort()).toEqual(["attendance", "users"]);
    expect(receipt.removed).toEqual({ users: 1, attendance: 1 });

    const left = await env.DB.prepare("SELECT COUNT(*) AS n FROM attendance").first<{ n: number }>();
    expect(left?.n).toBe(0);
  });
});
