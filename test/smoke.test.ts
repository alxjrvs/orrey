import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/http/app.ts";
import { encodeCustomId } from "../src/discord/custom-id.ts";
import { InteractionResponseType, InteractionType } from "../src/discord/types.ts";
import { getUser } from "../src/db/users.ts";
import { tally, tallyKey } from "../src/do/session-lock.ts";
import { fakeDiscord } from "./discord.ts";

const discord = await fakeDiscord();
const app = createApp();

interface Rewrite {
  type: number;
  data: { content: string; components?: { components: { custom_id: string }[] }[] };
}

async function clickPing(target: string, user: { id: string; name: string }): Promise<Rewrite> {
  const res = await app.fetch(
    await discord.request({
      type: InteractionType.MESSAGE_COMPONENT,
      data: { custom_id: encodeCustomId({ action: "ping", target }), component_type: 2 },
      member: { user: { id: user.id, username: user.name, global_name: user.name }, roles: [] },
      message: { id: "m1", channel_id: "c1" },
    }),
    discord.env(env),
  );
  expect(res.status).toBe(200);
  return (await res.json()) as Rewrite;
}

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM users").run();
  await env.DB.prepare("DELETE FROM settings").run();
});

describe("the phase-0 exit criterion", () => {
  it("round-trips a click to D1 and rewrites that message", async () => {
    const first = await clickPing("s1", { id: "1001", name: "Ada" });

    expect(first.type).toBe(InteractionResponseType.UPDATE_MESSAGE);
    expect(first.data.content).toMatch(/1 click, last by Ada/);
    expect(await tally(env, tallyKey("s1"))).toMatchObject({ clicks: 1, lastBy: "Ada" });
  });

  it("carries an as-of line and keeps its button, so a stale post can be refreshed", async () => {
    const rewritten = await clickPing("s1", { id: "1001", name: "Ada" });

    expect(rewritten.data.content).toMatch(/As of \d{4}-\d{2}-\d{2}T/);
    // The next click is a fresh interaction with a fresh token — which is why
    // the 15-minute token lifetime does not matter under send-only.
    expect(rewritten.data.components?.[0]?.components?.[0]?.custom_id).toBe("o1:ping::s1");
  });

  it("remembers the clicker, minting one feed token and refreshing the name cache", async () => {
    await clickPing("s1", { id: "1001", name: "Ada" });
    const first = await getUser(env, "1001");
    expect(first?.feedToken).toMatch(/^[0-9a-v]{32}$/);

    await clickPing("s1", { id: "1001", name: "Ada Lovelace" });
    const second = await getUser(env, "1001");
    expect(second?.globalName).toBe("Ada Lovelace");
    // A calendar client cannot re-subscribe on its own: the token must not move.
    expect(second?.feedToken).toBe(first?.feedToken);
  });

  it("serialises concurrent clicks through the session lock — no lost updates", async () => {
    const clicks = await Promise.all(
      Array.from({ length: 6 }, (_, i) => clickPing("s1", { id: `100${i}`, name: `P${i}` })),
    );

    // Every click rendered a distinct tally, and the last one rendered six.
    const counts = clicks
      .map((c) => Number(/(\d+) clicks?/.exec(c.data.content)?.[1]))
      .sort((a, b) => a - b);
    expect(counts).toEqual([1, 2, 3, 4, 5, 6]);
    expect(await tally(env, tallyKey("s1"))).toMatchObject({ clicks: 6 });
  });

  it("keeps separate targets on separate locks", async () => {
    await clickPing("s1", { id: "1001", name: "Ada" });
    await clickPing("s2", { id: "1001", name: "Ada" });

    expect(await tally(env, tallyKey("s1"))).toMatchObject({ clicks: 1 });
    expect(await tally(env, tallyKey("s2"))).toMatchObject({ clicks: 1 });
  });
});
