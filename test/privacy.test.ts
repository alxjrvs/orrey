import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/http/app.ts";
import { deleteUserData } from "../src/privacy/delete.ts";
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
    const receipt = await deleteUserData(env, "1001");
    expect(Object.keys(receipt.removed)).toEqual(["users"]);
    expect(receipt.removed).toEqual({ users: 1 });
  });
});
