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
  /**
   * How many sessions ahead the materialiser keeps in D1 and on Google. The
   * Discord horizon is separate and much shorter — two per campaign, because
   * scheduled events are capped per guild and treated as disposable.
   */
  horizonSessions: "horizon.sessions",
  /** How long before a session starts its attendance post goes up, in days. */
  attendanceLeadDays: "attendance.lead_days",
  /**
   * The role that may administer. Read with the bot token against the guild
   * member endpoint — never from the user's own OAuth token, which is why the
   * console never asks for the `guilds` scope.
   */
  organiserRoleId: "discord.organiser_role_id",
} as const;

/** Used when the setting has not been written. Stated here, next to the key. */
export const SETTING_DEFAULTS = {
  [SETTING_KEYS.horizonSessions]: 4,
  [SETTING_KEYS.attendanceLeadDays]: 10,
  [SETTING_KEYS.timezone]: "Europe/London",
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

/** A setting with its default, for the keys that have one. */
export async function settingOr<T>(env: Env, key: SettingKey, fallback: T): Promise<T> {
  return (await getSetting<T>(env, key)) ?? fallback;
}
