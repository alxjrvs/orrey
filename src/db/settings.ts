import { eq, sql } from "drizzle-orm";
import type { Env } from "../env.ts";
import { db, schema } from "./index.ts";

/**
 * Single-guild key/value. Orrey adopts the Discord objects Hermuz created
 * rather than making a parallel set, so these ids arrive at cutover and are
 * read from here afterwards — never guessed, never hardcoded.
 */
export const SETTING_KEYS = {
  guildId: "discord.guild_id",
  /** Where anything not belonging to a campaign channel is posted. */
  schedulingChannelId: "discord.scheduling_channel_id",
  /** IANA zone for recurrence and reminders. */
  timezone: "timezone",
} as const;

export type SettingKey = (typeof SETTING_KEYS)[keyof typeof SETTING_KEYS] | (string & {});

export async function getSetting<T>(env: Env, key: SettingKey): Promise<T | undefined> {
  const row = await db(env).select().from(schema.settings).where(eq(schema.settings.key, key)).get();
  return row?.value as T | undefined;
}

export async function setSetting(env: Env, key: SettingKey, value: unknown): Promise<void> {
  await db(env)
    .insert(schema.settings)
    .values({ key, value })
    .onConflictDoUpdate({
      target: schema.settings.key,
      set: { value, updatedAt: sql`(unixepoch())` },
    });
}

/** Reads the guild id, or says plainly that cutover has not seeded it yet. */
export async function requireGuildId(env: Env): Promise<string> {
  const guildId = await getSetting<string>(env, SETTING_KEYS.guildId);
  if (!guildId) throw new Error(`setting ${SETTING_KEYS.guildId} is not seeded — run the cutover`);
  return guildId;
}
