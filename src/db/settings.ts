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
   * The role that may administer. Read with the bot token against the guild
   * member endpoint — never from the user's own OAuth token, which is why the
   * console never asks for the `guilds` scope.
   */
  organiserRoleId: "discord.organiser_role_id",
  /**
   * How many sessions ahead the materialiser keeps in D1 and on Google. The
   * Discord horizon is separate and much shorter — two per campaign, because
   * scheduled events are capped per guild and treated as disposable.
   */
  horizonSessions: "horizon.sessions",
  /** How long before a session starts its attendance post goes up, in days. */
  attendanceLeadDays: "attendance.lead_days",
  /** How long before a session starts Orrey asks whether it still runs, in hours. */
  jeopardyLeadHours: "jeopardy.lead_hours",
  /** How many hours before a session each reminder goes out. Descending. */
  reminderStepsHours: "reminder.steps_hours",
  /** How long a date poll takes answers for, in hours. */
  pollWindowHours: "poll.window_hours",
  /**
   * How long before a game day starts its table settles, in hours.
   *
   * Long enough that whoever is running it can plan for the people who are
   * actually coming, short enough that somebody deciding on the day before is
   * not too late. Forty-eight is the compromise; the organiser can lock sooner
   * by hand, and nothing unlocks.
   */
  gameDayLockLeadHours: "gameday.lock_lead_hours",
  /**
   * The open push channel on the Orrey calendar: its id, resource id, shared
   * token and expiry.
   *
   * One row because there is exactly one calendar. The token is the channel's
   * shared secret — it is what the webhook compares an incoming push against —
   * so it is stored here and appears in no log line.
   */
  googleWatch: "google.watch",
  /**
   * Google's own cursor into the Orrey calendar.
   *
   * Absent means "list everything next time", which is the honest starting
   * state and also the recovery: Google expires these on its own schedule, and
   * a `410 Gone` clears this row rather than raising anything.
   */
  googleSyncToken: "google.sync_token",
} as const;

/** Used when the setting has not been written. Stated here, next to the key. */
export const SETTING_DEFAULTS = {
  [SETTING_KEYS.horizonSessions]: 4,
  [SETTING_KEYS.attendanceLeadDays]: 10,
  [SETTING_KEYS.jeopardyLeadHours]: 24,
  [SETTING_KEYS.reminderStepsHours]: [72, 24, 2],
  [SETTING_KEYS.pollWindowHours]: 72,
  [SETTING_KEYS.gameDayLockLeadHours]: 48,
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
/**
 * Take a setting away, as opposed to writing an empty one.
 *
 * `settings.value` is NOT NULL, so "no value" is an absent row rather than a
 * null in one — and absent is what every reader already treats as "not set".
 */
export async function clearSetting(env: Env, key: SettingKey): Promise<void> {
  await db(env).delete(schema.settings).where(eq(schema.settings.key, key));
}

export async function requireGuildId(env: Env): Promise<string> {
  const guildId = await getSetting<string>(env, SETTING_KEYS.guildId);
  if (!guildId) throw new Error(`setting ${SETTING_KEYS.guildId} is not seeded — run the cutover`);
  return guildId;
}

/** A setting with its default, for the keys that have one. */
export async function settingOr<T>(env: Env, key: SettingKey, fallback: T): Promise<T> {
  return (await getSetting<T>(env, key)) ?? fallback;
}
