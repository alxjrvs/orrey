import { eq, sql } from "drizzle-orm";
import type { Env } from "../env.ts";
import { db, schema } from "../db/index.ts";
import { SETTING_DEFAULTS, SETTING_KEYS, getSetting } from "../db/settings.ts";

/**
 * The settings page: the keys, and only the keys.
 *
 * Every key here is one phases 0 through 3 already write and already read. This
 * adds validation and a form; it invents no key and no table. A key nothing
 * reads yet is schema ahead of the phase wearing a different costume, and does
 * not get a field.
 *
 * **The allow-list is the mechanism.** A settings page that writes whatever key
 * it is handed is a settings page that can seed a key the rest of the Worker
 * will never look at — an entry that looks like configuration, reads like
 * configuration, and does nothing, which is worse than no page at all. So an
 * unknown key is refused rather than stored, and the test says so.
 */
export class InvalidSetting extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidSetting";
  }
}

export type SettingKind = "text" | "number" | "list" | "zone";

export interface SettingField {
  key: string;
  label: string;
  kind: SettingKind;
  /** What it is for, in the words the key's own comment uses. */
  help: string;
  /**
   * What changing it costs, where it costs something. Stated on the page and not
   * only in a commit message: a number that quietly stops being true is worse
   * than one nobody touched.
   */
  caveat?: string;
  value: unknown;
  /** The value used when nothing is written, so a blank field is not a mystery. */
  fallback: unknown;
  /**
   * False for `discord.guild_id`. Re-pointing the guild from a web form is not a
   * setting, it is a migration — `scripts/adopt-ids.ts` owns it, and every id in
   * the database belongs to the guild it names.
   */
  writable: boolean;
}

const FIELDS: Omit<SettingField, "value" | "fallback">[] = [
  {
    key: SETTING_KEYS.guildId,
    label: "Guild",
    kind: "text",
    help: "The Discord guild Orrey adopts. Every id in the database belongs to it.",
    caveat: "Read-only. `scripts/adopt-ids.ts` owns this — re-pointing the guild is a migration, not a setting.",
    writable: false,
  },
  {
    key: SETTING_KEYS.schedulingChannelId,
    label: "Scheduling channel",
    kind: "text",
    help: "Where anything not belonging to a campaign channel is posted.",
    writable: true,
  },
  {
    key: SETTING_KEYS.organiserRoleId,
    label: "Organiser role",
    kind: "text",
    help: "The role that may administer. Read with the bot token, never from your own OAuth token.",
    caveat: "Get this wrong and nobody can reach this page. It is read fresh on every request, so a correction takes effect immediately.",
    writable: true,
  },
  {
    key: SETTING_KEYS.timezone,
    label: "Guild timezone",
    kind: "zone",
    help: "The zone recurrence, reminders and day headings are reckoned in.",
    caveat: "Changes which calendar day an evening session falls on for everybody at once. It does not move any session.",
    writable: true,
  },
  {
    key: SETTING_KEYS.horizonSessions,
    label: "Horizon",
    kind: "number",
    help: "How many sessions ahead the materialiser keeps in D1 and on Google.",
    caveat: "Shrinking it does not delete sessions already materialised. It only stops new ones being added until the horizon catches up.",
    writable: true,
  },
  {
    key: SETTING_KEYS.attendanceLeadDays,
    label: "Attendance post lead",
    kind: "number",
    help: "How many days before a session its attendance post goes up.",
    writable: true,
  },
  {
    key: SETTING_KEYS.jeopardyLeadHours,
    label: "Jeopardy check lead",
    kind: "number",
    help: "How many hours before a session Orrey asks whether it still runs.",
    writable: true,
  },
  {
    key: SETTING_KEYS.reminderStepsHours,
    label: "Reminder ladder",
    kind: "list",
    help: "How many hours before a session each reminder goes out. Descending.",
    caveat: "Changing it does not re-arm reminders already scheduled.",
    writable: true,
  },
  {
    key: SETTING_KEYS.pollWindowHours,
    label: "Poll window",
    kind: "number",
    help: "How long a date poll takes answers for, in hours.",
    writable: true,
  },
  {
    key: SETTING_KEYS.gameDayLockLeadHours,
    label: "Game day lock lead",
    kind: "number",
    help: "How many hours before a game day starts its table settles.",
    caveat: "Nothing unlocks. An organiser can always lock sooner by hand.",
    writable: true,
  },
];

const BY_KEY = new Map(FIELDS.map((field) => [field.key, field]));

export async function settingsView(env: Env): Promise<SettingField[]> {
  return Promise.all(
    FIELDS.map(async (field) => ({
      ...field,
      value: await getSetting(env, field.key),
      fallback: (SETTING_DEFAULTS as Record<string, unknown>)[field.key] ?? null,
    })),
  );
}

/**
 * Write one key, with the old value and the new one in the same audit row.
 *
 * The old value is the point of the row. "Somebody changed the horizon" is not
 * an audit trail; "somebody changed the horizon from 4 to 1" is.
 */
export async function putSetting(
  env: Env,
  key: string,
  value: unknown,
  actor: string,
): Promise<void> {
  const field = BY_KEY.get(key);
  if (!field) throw new InvalidSetting(`${key} is not a setting Orrey reads`);
  if (!field.writable) {
    throw new InvalidSetting(
      `${field.label} is read-only here — scripts/adopt-ids.ts owns it, because re-pointing the guild is a migration and not a setting`,
    );
  }

  const parsed = parse(field, value);
  const before = await getSetting(env, key);

  const d = db(env);
  await d.batch([
    d
      .insert(schema.settings)
      .values({ key, value: parsed })
      .onConflictDoUpdate({
        target: schema.settings.key,
        set: { value: parsed, updatedAt: sql`(unixepoch())` },
      }),
    d.insert(schema.auditLog).values({
      id: crypto.randomUUID(),
      actorUserId: actor,
      action: "setting.update",
      targetType: "setting",
      targetId: key,
      detail: { before: before ?? null, after: parsed },
    }),
  ]);
}

function parse(field: Omit<SettingField, "value" | "fallback">, value: unknown): unknown {
  switch (field.kind) {
    case "text": {
      if (typeof value !== "string" || value.trim() === "") {
        throw new InvalidSetting(`${field.label} needs a value`);
      }
      return value.trim();
    }
    case "number": {
      const n = typeof value === "number" ? value : Number(value);
      if (!Number.isInteger(n) || n <= 0) {
        throw new InvalidSetting(`${field.label} is a whole number of one or more`);
      }
      return n;
    }
    case "zone": {
      const zone = typeof value === "string" ? value.trim() : "";
      // Asked of `Intl` rather than matched against a list. A list goes stale the
      // next time a country moves its clocks, and a zone the runtime does not
      // know is a zone every rendering in the repo would throw on.
      try {
        new Intl.DateTimeFormat("en-GB", { timeZone: zone });
      } catch {
        throw new InvalidSetting(`${zone || "that"} is not a timezone this runtime knows`);
      }
      return zone;
    }
    case "list": {
      const steps = Array.isArray(value) ? value.map(Number) : String(value).split(/[,\s]+/).filter(Boolean).map(Number);
      if (steps.length === 0 || steps.some((step) => !Number.isInteger(step) || step <= 0)) {
        throw new InvalidSetting(`${field.label} is a list of whole hours, each one or more`);
      }
      // Strictly descending, which is what "hours before the session" means:
      // 72, 24, 2. A ladder that is not ordered is one where the reminder
      // scheduler's "next step" is whichever row it happened to read first.
      for (let i = 1; i < steps.length; i++) {
        if ((steps[i] as number) >= (steps[i - 1] as number)) {
          throw new InvalidSetting(
            `${field.label} counts down to the session, so each step is fewer hours than the one before it`,
          );
        }
      }
      return steps;
    }
  }
}

/** For the tests, and for anything that wants the row rather than the value. */
export function settingRow(env: Env, key: string) {
  return db(env).select().from(schema.settings).where(eq(schema.settings.key, key)).get();
}
