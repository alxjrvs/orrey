import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db, schema } from "../src/db/index.ts";
import { SETTING_KEYS, setSetting } from "../src/db/settings.ts";
import { tryDm } from "../src/attendance/dm.ts";

/**
 * Bot DMs cannot be pre-checked. `50007` arrives *after* the attempt, which is
 * the whole shape of this: try once, remember forever, fall back.
 */
const realFetch = globalThis.fetch;

let calls: { path: string; body: Record<string, unknown> }[] = [];
let messageResponse: () => Response;

const payload = {
  content: "still coming?",
  components: [],
  allowed_mentions: { parse: [] as never[], roles: [] },
};

function dmStateOf(userId = "1001") {
  return db(env)
    .select({ dmState: schema.users.dmState })
    .from(schema.users)
    .where(eq(schema.users.discordId, userId))
    .get()
    .then((row) => row?.dmState);
}

beforeEach(async () => {
  calls = [];
  messageResponse = () => Response.json({ id: "dm-msg-1", channel_id: "dm-1" });

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    const path = url.pathname.replace("/api/v10", "");
    calls.push({ path, body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });

    if (path === "/users/@me/channels") return Response.json({ id: "dm-1" });
    return messageResponse();
  }) as typeof fetch;

  await env.DB.prepare("DELETE FROM users").run();
  await env.DB.prepare("DELETE FROM settings").run();
  await setSetting(env, SETTING_KEYS.guildId, "g1");
  await db(env)
    .insert(schema.users)
    .values({ discordId: "1001", username: "ada", feedToken: "t" });
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("trying a DM", () => {
  it("opens the channel and posts into it", async () => {
    expect(await tryDm(env, "1001", payload)).toBe("sent");

    expect(calls.map((call) => call.path)).toEqual([
      "/users/@me/channels",
      "/channels/dm-1/messages",
    ]);
    expect(calls[0]?.body).toMatchObject({ recipient_id: "1001" });
  });

  it("remembers that it worked", async () => {
    expect(await dmStateOf()).toBe("unknown");
    await tryDm(env, "1001", payload);

    // Not required, but it turns the next reminder's first attempt from a guess
    // into a known-good one.
    expect(await dmStateOf()).toBe("open");
  });

  it("learns from 50007 and treats it as permanent", async () => {
    messageResponse = () =>
      Response.json({ code: 50007, message: "Cannot send messages to this user" }, { status: 403 });

    expect(await tryDm(env, "1001", payload)).toBe("closed");
    expect(await dmStateOf()).toBe("closed");
  });

  it("does not ask again once it knows", async () => {
    await db(env)
      .update(schema.users)
      .set({ dmState: "closed" })
      .where(eq(schema.users.discordId, "1001"));

    expect(await tryDm(env, "1001", payload)).toBe("already-closed");
    // Trying again every reminder would spend a rate-limit slot on a refusal
    // Discord has already given.
    expect(calls).toEqual([]);
  });

  it("lets a real failure through rather than calling it a closed DM", async () => {
    messageResponse = () =>
      Response.json({ code: 50013, message: "Missing Permissions" }, { status: 403 });

    await expect(tryDm(env, "1001", payload)).rejects.toThrow();
    // A permissions problem is not somebody's DM setting, and recording it as
    // one would silently stop ever trying them again.
    expect(await dmStateOf()).toBe("unknown");
  });

  it("tries somebody Orrey has never stored, rather than assuming", async () => {
    expect(await tryDm(env, "9999", payload)).toBe("sent");
    expect(calls.map((call) => call.path)).toContain("/users/@me/channels");
  });
});
