import { and, eq, sql } from "drizzle-orm";
import type { Env } from "../env.ts";
import { db, schema } from "../db/index.ts";

/**
 * What somebody played on a multi game day.
 *
 * #7 asked whether Orrey should model tables — a `tables` table, seats per
 * table, people assigned to one. The answer settled here is no: **one optional
 * free-text column on `attendance`**, filled in by whoever ran the day, and
 * nothing reads it but the correction post and the console.
 *
 * Tables form on the day. Who ended up at which one is a thing that gets
 * recorded afterwards, if anybody bothers, and a schema that insists on it would
 * be a schema that is wrong about most evenings. The column is keyed
 * `(session_id, user_id)` by construction, so it is per person without any
 * further structure.
 */
export interface DayHost {
  gameDayId: string;
  kind: "single" | "multi";
  hostUserId: string | null;
}

/** The day this session belongs to, if it belongs to one. */
export async function dayOfSession(env: Env, sessionId: string): Promise<DayHost | undefined> {
  const row = await db(env)
    .select({
      gameDayId: schema.gameDays.id,
      kind: schema.gameDays.kind,
      hostUserId: schema.gameDays.hostUserId,
    })
    .from(schema.sessions)
    .innerJoin(schema.gameDays, eq(schema.sessions.gameDayId, schema.gameDays.id))
    .where(eq(schema.sessions.id, sessionId))
    .get();

  return row ?? undefined;
}

/** Whether the correction post for this session carries the button at all. */
export async function isMultiDaySession(env: Env, sessionId: string): Promise<boolean> {
  return (await dayOfSession(env, sessionId))?.kind === "multi";
}

export type HostCheck = "yes" | "no" | "no-host" | "not-a-day";

/**
 * Whoever ran the day, and nobody else.
 *
 * The same shape as the attended toggles' guard and for the same reason: the
 * register is what flake memory reads, and a register anybody can edit is a
 * register nobody can rely on. A campaign session's guard is `isGm`; a day's is
 * its host.
 *
 * A day with no host set fails **closed** and says which way. "Nobody is down as
 * running this" is wrong in a way somebody notices and can fix in the console;
 * letting everybody write is wrong in a way nobody notices until it matters.
 */
export async function hostCheck(
  env: Env,
  sessionId: string,
  userId: string,
): Promise<HostCheck> {
  const day = await dayOfSession(env, sessionId);
  if (!day) return "not-a-day";
  if (!day.hostUserId) return "no-host";
  return day.hostUserId === userId ? "yes" : "no";
}

/** The line stored against one person, for prefilling the modal from D1. */
export async function tablesPlayedFor(
  env: Env,
  sessionId: string,
  userId: string,
): Promise<string | null> {
  const row = await db(env)
    .select({ tablesPlayed: schema.attendance.tablesPlayed })
    .from(schema.attendance)
    .where(
      and(eq(schema.attendance.sessionId, sessionId), eq(schema.attendance.userId, userId)),
    )
    .get();

  return row?.tablesPlayed ?? null;
}

/**
 * Store it, or clear it.
 *
 * Normalised on the way in rather than on the way out, exactly like a note: it
 * is rendered inline on a post Orrey can never edit, so a newline would break
 * that post's layout permanently. An empty box means "clear it".
 *
 * It only ever updates an existing register row. Somebody with no row was not on
 * the register, and inventing one here would be recording attendance through the
 * side door.
 */
export async function setTablesPlayed(
  env: Env,
  sessionId: string,
  userId: string,
  text: string,
): Promise<string | null> {
  const cleaned = normaliseTablesPlayed(text);

  await db(env)
    .update(schema.attendance)
    .set({ tablesPlayed: cleaned, updatedAt: sql`(unixepoch())` })
    .where(
      and(eq(schema.attendance.sessionId, sessionId), eq(schema.attendance.userId, userId)),
    );

  return cleaned;
}

/** One line, no surprises, short enough to sit beside a name. */
export function normaliseTablesPlayed(text: string): string | null {
  const cleaned = text.replace(/\s+/g, " ").trim().slice(0, 140);
  return cleaned.length > 0 ? cleaned : null;
}
