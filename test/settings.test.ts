import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { SETTING_KEYS, getSetting, requireGuildId, setSetting } from "../src/db/settings.ts";

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM settings").run();
});

describe("settings", () => {
  it("round-trips JSON values and overwrites in place", async () => {
    await setSetting(env, SETTING_KEYS.guildId, "123");
    expect(await getSetting(env, SETTING_KEYS.guildId)).toBe("123");

    await setSetting(env, SETTING_KEYS.guildId, "456");
    expect(await getSetting(env, SETTING_KEYS.guildId)).toBe("456");

    await setSetting(env, "feature.flags", { polls: true });
    expect(await getSetting(env, "feature.flags")).toEqual({ polls: true });
  });

  it("says plainly when cutover has not seeded the guild id", async () => {
    await expect(requireGuildId(env)).rejects.toThrow(/not seeded — run the cutover/);
    await setSetting(env, SETTING_KEYS.guildId, "123");
    expect(await requireGuildId(env)).toBe("123");
  });

  it("accepts the SQL the id-adoption script emits", async () => {
    // The exact shape scripts/adopt-ids.ts --sql prints.
    await env.DB.prepare(
      `INSERT INTO settings (key, value) VALUES ('discord.guild_id', '"999"')
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = unixepoch()`,
    ).run();
    expect(await getSetting(env, SETTING_KEYS.guildId)).toBe("999");
  });
});
