import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/http/app.ts";
import { db, schema } from "../src/db/index.ts";
import { seedStatements } from "../src/db/seed-sql.ts";
import { encodeCustomId } from "../src/discord/custom-id.ts";
import { InteractionResponseType, InteractionType } from "../src/discord/types.ts";
import { getUser } from "../src/db/users.ts";
import { fakeDiscord } from "./discord.ts";

const discord = await fakeDiscord();
const app = createApp();

interface Rewrite {
  type: number;
  data: {
    content: string;
    components?: { components: { custom_id: string }[] }[];
    allowed_mentions?: unknown;
  };
}

const SESSION_ID = "age-of-umbra-s12";

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
 * A click, as Discord sends it — including a `message` whose content is a lie.
 * Orrey must answer from D1; if it ever read the message it came from, this is
 * the test that would notice.
 */
async function click(
  arg: string,
  user: { id: string; name: string },
  sessionId = SESSION_ID,
): Promise<Rewrite> {
  const res = await app.fetch(
    await discord.request({
      type: InteractionType.MESSAGE_COMPONENT,
      data: { custom_id: encodeCustomId({ action: "attend", arg, target: sessionId }), component_type: 2 },
      member: { user: { id: user.id, username: user.name, global_name: user.name }, roles: [] },
      message: { id: "m1", channel_id: "chan-1", content: "**In (99)** — Everybody" },
    }),
    discord.env(env),
  );
  expect(res.status).toBe(200);
  return (await res.json()) as Rewrite;
}

function countIn(rewrite: Rewrite): number {
  return Number(rewrite.data.content.match(/\*\*In \((\d+)\)\*\*/)?.[1] ?? 0);
}

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM attendance").run();
  await env.DB.prepare("DELETE FROM jobs").run();
  await env.DB.prepare("DELETE FROM sessions").run();
  await env.DB.prepare("DELETE FROM campaigns").run();
  await env.DB.prepare("DELETE FROM users").run();
  for (const statement of seedStatements(campaign, session)) {
    await env.DB.prepare(statement).run();
  }
});

describe("clicking In / Out / Maybe", () => {
  it("writes the intent and rewrites the message it came from", async () => {
    const rewrite = await click("in", { id: "1001", name: "Ada" });

    expect(rewrite.type).toBe(InteractionResponseType.UPDATE_MESSAGE);
    expect(rewrite.data.content).toContain("**In (1)** — Ada");
    expect(await db(env).select().from(schema.attendance).get()).toMatchObject({
      sessionId: SESSION_ID,
      userId: "1001",
      intent: "in",
    });
  });

  it("renders from D1, never from the message the click came from", async () => {
    const rewrite = await click("in", { id: "1001", name: "Ada" });
    // The incoming message claimed 99. The database said one.
    expect(countIn(rewrite)).toBe(1);
  });

  it("lets someone change their mind without leaving two rows", async () => {
    await click("in", { id: "1001", name: "Ada" });
    const rewrite = await click("out", { id: "1001", name: "Ada" });

    expect(rewrite.data.content).toContain("**Out (1)** — Ada");
    expect(rewrite.data.content).not.toContain("**In (1)**");
    expect(await db(env).select().from(schema.attendance).all()).toHaveLength(1);
  });

  it("serialises simultaneous clicks: no two of them read the same tally", async () => {
    const [first, second] = await Promise.all([
      click("in", { id: "1001", name: "Ada" }),
      click("in", { id: "1002", name: "Bob" }),
    ]);

    // Whichever went second saw both. Neither saw the other's reading.
    expect([countIn(first), countIn(second)].sort()).toEqual([1, 2]);
    expect(await db(env).select().from(schema.attendance).all()).toHaveLength(2);
  });

  it("remembers the clicker and keeps their name cache current", async () => {
    await click("in", { id: "1001", name: "Ada" });
    expect((await getUser(env, "1001"))?.globalName).toBe("Ada");

    await click("maybe", { id: "1001", name: "Ada Lovelace" });
    expect((await getUser(env, "1001"))?.globalName).toBe("Ada Lovelace");
  });

  it("keeps its buttons, so the post stays clickable after every rewrite", async () => {
    const rewrite = await click("in", { id: "1001", name: "Ada" });
    const ids = rewrite.data.components?.[0]?.components.map((c) => c.custom_id);

    expect(ids).toEqual([
      "o1:attend:in:age-of-umbra-s12",
      "o1:attend:out:age-of-umbra-s12",
      "o1:attend:maybe:age-of-umbra-s12",
      "o1:attend:note:age-of-umbra-s12",
      "o1:attend:refresh:age-of-umbra-s12",
    ]);
  });
});

describe("Refresh", () => {
  it("re-renders without writing anything", async () => {
    await click("in", { id: "1001", name: "Ada" });
    const before = await db(env).select().from(schema.attendance).get();

    const rewrite = await click("refresh", { id: "1002", name: "Bob" });

    expect(rewrite.type).toBe(InteractionResponseType.UPDATE_MESSAGE);
    expect(rewrite.data.content).toContain("**In (1)** — Ada");
    // Refreshing is not answering: Bob said nothing by asking.
    expect(await db(env).select().from(schema.attendance).all()).toHaveLength(1);
    expect(await db(env).select().from(schema.attendance).get()).toEqual(before);
  });

  it("carries a fresh as-of line", async () => {
    const rewrite = await click("refresh", { id: "1001", name: "Ada" });
    expect(rewrite.data.content).toMatch(/As of <t:\d+:R>/);
  });
});

describe("clicks that cannot be honoured", () => {
  it("retires a post whose session has been deleted", async () => {
    await env.DB.prepare("DELETE FROM sessions").run();
    const answer = await click("in", { id: "1001", name: "Ada" });

    expect(answer.type).toBe(InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE);
    expect(answer.data.content).toMatch(/retired/);
  });

  it("retires an id Orrey minted but no longer understands", async () => {
    const answer = await click("sideways", { id: "1001", name: "Ada" });
    expect(answer.data.content).toMatch(/retired/);
  });

  it("retires a click with no session on it", async () => {
    const answer = await click("in", { id: "1001", name: "Ada" }, "");
    expect(answer.data.content).toMatch(/retired/);
  });
});
