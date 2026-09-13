import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/http/app.ts";
import { InteractionResponseType, InteractionType, MessageFlags } from "../src/discord/types.ts";
import { fakeDiscord } from "./discord.ts";

const discord = await fakeDiscord();
const app = createApp();

async function interact(body: unknown, opts?: { tamper?: boolean }) {
  return app.fetch(await discord.request(body, opts), discord.env(env));
}

const member = { user: { id: "1001", username: "ada", global_name: "Ada" }, roles: [] };

describe("POST /interactions", () => {
  it("returns 401 on a bad signature — Discord probes for exactly this on save", async () => {
    const res = await interact({ type: InteractionType.PING }, { tamper: true });
    expect(res.status).toBe(401);
  });

  it("returns 401 when the signature headers are absent", async () => {
    const res = await app.fetch(
      new Request("https://orrey.test/interactions", { method: "POST", body: "{}" }),
      discord.env(env),
    );
    expect(res.status).toBe(401);
  });

  it("answers PING with PONG", async () => {
    const res = await interact({ type: InteractionType.PING });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ type: InteractionResponseType.PONG });
  });

  it("answers every command ephemerally", async () => {
    for (const name of ["upcoming", "reschedule", "whos-in", "console", "task"]) {
      const res = await interact({
        type: InteractionType.APPLICATION_COMMAND,
        data: { name },
        member,
        guild_id: "g",
      });
      const json = (await res.json()) as { type: number; data: { flags: number } };
      expect(json.type).toBe(InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE);
      expect(json.data.flags & MessageFlags.EPHEMERAL).toBeTruthy();
    }
  });

  it("degrades an unknown custom_id to the retired-post response, never a failure", async () => {
    for (const custom_id of ["hermuz:rsvp:yes", "", "o1:no-such-action"]) {
      const res = await interact({
        type: InteractionType.MESSAGE_COMPONENT,
        data: { custom_id, component_type: 2 },
        member,
        message: { id: "m1", channel_id: "c1" },
      });
      expect(res.status).toBe(200);
      const json = (await res.json()) as { type: number; data: { content: string; flags: number } };
      expect(json.type).toBe(InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE);
      expect(json.data.flags & MessageFlags.EPHEMERAL).toBeTruthy();
      expect(json.data.content).toMatch(/retired/);
    }
  });

  it("answers autocomplete with a (still empty) choice list", async () => {
    const res = await interact({
      type: InteractionType.APPLICATION_COMMAND_AUTOCOMPLETE,
      data: { name: "reschedule", options: [{ name: "event", value: "", focused: true }] },
      member,
    });
    expect(await res.json()).toEqual({
      type: InteractionResponseType.APPLICATION_COMMAND_AUTOCOMPLETE_RESULT,
      data: { choices: [] },
    });
  });
});
