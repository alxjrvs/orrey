import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/http/app.ts";
import { db, schema } from "../src/db/index.ts";
import { seedStatements } from "../src/db/seed-sql.ts";
import { decodeCustomId, encodeCustomId } from "../src/discord/custom-id.ts";
import { ComponentType, InteractionResponseType, InteractionType } from "../src/discord/types.ts";
import { normaliseNote } from "../src/do/session-lock.ts";
import { fakeDiscord } from "./discord.ts";

const discord = await fakeDiscord();
const app = createApp();

const SESSION_ID = "age-of-umbra-s12";

interface Answer {
  type: number;
  data: {
    content?: string;
    custom_id?: string;
    title?: string;
    components?: { components: { custom_id?: string; max_length?: number; required?: boolean }[] }[];
  };
}

const member = (id: string, name: string) => ({
  user: { id, username: name.toLowerCase(), global_name: name },
  roles: [],
});

async function send(body: unknown): Promise<Answer> {
  const res = await app.fetch(await discord.request(body), discord.env(env));
  expect(res.status).toBe(200);
  return (await res.json()) as Answer;
}

function clickNote(user: { id: string; name: string }) {
  return send({
    type: InteractionType.MESSAGE_COMPONENT,
    data: {
      custom_id: encodeCustomId({ action: "attend", arg: "note", target: SESSION_ID }),
      component_type: 2,
    },
    member: member(user.id, user.name),
    message: { id: "m1", channel_id: "chan-1" },
  });
}

function submitNote(user: { id: string; name: string }, value: string, customId?: string) {
  return send({
    type: InteractionType.MODAL_SUBMIT,
    data: {
      custom_id: customId ?? encodeCustomId({ action: "attend-note", target: SESSION_ID }),
      components: [{ type: 1, components: [{ custom_id: "note", value }] }],
    },
    member: member(user.id, user.name),
    message: { id: "m1", channel_id: "chan-1" },
  });
}

const campaign = { name: "Age of Umbra", kind: "run", discordChannelId: "chan-1", discordRoleId: "role-1" } as const;
const session = {
  number: 12,
  startsAt: Date.parse("2026-09-20T19:00:00Z") / 1000,
  endsAt: Date.parse("2026-09-20T23:00:00Z") / 1000,
  location: "The Wreck",
};

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

describe("the Note button", () => {
  it("opens a modal whose id Orrey can read back", async () => {
    const answer = await clickNote({ id: "1001", name: "Ada" });

    expect(answer.type).toBe(InteractionResponseType.MODAL);
    expect(decodeCustomId(answer.data.custom_id ?? "")).toMatchObject({
      action: "attend-note",
      target: SESSION_ID,
    });

    const input = answer.data.components?.[0]?.components[0];
    expect(input).toMatchObject({ custom_id: "note", required: false, max_length: 140 });
    expect(answer.data.components?.[0]?.components[0]).toBeDefined();
    expect((input as { type?: number }).type).toBe(ComponentType.TEXT_INPUT);
  });

  it("writes nothing by being opened", async () => {
    await clickNote({ id: "1001", name: "Ada" });
    expect(await db(env).select().from(schema.attendance).all()).toEqual([]);
  });
});

describe("submitting the modal", () => {
  it("stores the note and rewrites the post it came from", async () => {
    await send({
      type: InteractionType.MESSAGE_COMPONENT,
      data: { custom_id: encodeCustomId({ action: "attend", arg: "in", target: SESSION_ID }), component_type: 2 },
      member: member("1001", "Ada"),
      message: { id: "m1", channel_id: "chan-1" },
    });

    const answer = await submitNote({ id: "1001", name: "Ada" }, "bringing snacks");

    expect(answer.type).toBe(InteractionResponseType.UPDATE_MESSAGE);
    expect(answer.data.content).toContain("**In (1)** — Ada (bringing snacks)");
    expect(await db(env).select().from(schema.attendance).get()).toMatchObject({
      intent: "in",
      note: "bringing snacks",
    });
  });

  it("shows a note from someone who has not said whether they are coming", async () => {
    const answer = await submitNote({ id: "1002", name: "Bob" }, "might make the second half");

    expect(answer.data.content).toContain("**Notes** — Bob (might make the second half)");
    expect(answer.data.content).not.toContain("Nobody has said yet");
    expect(await db(env).select().from(schema.attendance).get()).toMatchObject({
      intent: null,
      note: "might make the second half",
    });
  });

  it("clears the note when the box comes back empty", async () => {
    await submitNote({ id: "1001", name: "Ada" }, "bringing snacks");
    const answer = await submitNote({ id: "1001", name: "Ada" }, "   ");

    expect(answer.data.content).not.toContain("snacks");
    expect(await db(env).select().from(schema.attendance).get()).toMatchObject({ note: null });
  });

  it("keeps a note to one line, because the post can never be tidied up later", () => {
    expect(normaliseNote("two\nlines   here")).toBe("two lines here");
    expect(normaliseNote("   ")).toBeNull();
    expect(normaliseNote("x".repeat(400))?.length).toBe(140);
  });

  it("leaves the intent alone", async () => {
    await send({
      type: InteractionType.MESSAGE_COMPONENT,
      data: { custom_id: encodeCustomId({ action: "attend", arg: "maybe", target: SESSION_ID }), component_type: 2 },
      member: member("1001", "Ada"),
      message: { id: "m1", channel_id: "chan-1" },
    });
    await submitNote({ id: "1001", name: "Ada" }, "depends on the trains");

    expect(await db(env).select().from(schema.attendance).get()).toMatchObject({
      intent: "maybe",
      note: "depends on the trains",
    });
  });

  it("escapes the markdown in a note, so it cannot imitate Orrey's own lines", async () => {
    const answer = await submitNote({ id: "1001", name: "Ada" }, "**Out (4)** — Bob, Cara");

    // The note is shown, but as text: the bold markers are escaped, so the post
    // cannot be made to claim four people dropped out.
    expect(answer.data.content).toContain("\\*\\*Out (4)\\*\\* — Bob, Cara");
    expect(answer.data.content).not.toMatch(/\*\*Out \(4\)\*\*/);
  });

  it("prefills the modal, so opening and submitting it cannot wipe a note", async () => {
    await submitNote({ id: "1001", name: "Ada" }, "bringing snacks");

    const reopened = await clickNote({ id: "1001", name: "Ada" });
    const input = reopened.data.components?.[0]?.components[0] as { value?: string };
    expect(input.value).toBe("bringing snacks");
  });

  it("does not reorder the lists — a note is not an answer", async () => {
    for (const [id, who] of [["1001", "Ada"], ["1002", "Bob"]] as const) {
      await send({
        type: InteractionType.MESSAGE_COMPONENT,
        data: { custom_id: encodeCustomId({ action: "attend", arg: "in", target: SESSION_ID }), component_type: 2 },
        member: member(id, who),
        message: { id: "m1", channel_id: "chan-1" },
      });
    }

    const answer = await submitNote({ id: "1001", name: "Ada" }, "bringing snacks");
    expect(answer.data.content).toContain("**In (2)** — Ada (bringing snacks), Bob");
  });

  it("retires a submission Orrey no longer understands", async () => {
    const stale = await submitNote({ id: "1001", name: "Ada" }, "hello", "hermuz:note:1");
    expect(stale.data.content).toMatch(/retired/);

    const gone = await submitNote({ id: "1001", name: "Ada" }, "hello", "o1:attend-note::no-such-session");
    expect(gone.data.content).toMatch(/retired/);
  });
});
