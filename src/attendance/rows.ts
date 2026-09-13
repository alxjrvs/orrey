import { asc, eq } from "drizzle-orm";
import type { Env } from "../env.ts";
import { db, schema } from "../db/index.ts";
import type { AttendanceRow } from "./render.ts";

/**
 * Who has said what, in the order they said it. Phase 1 has no roster table, so
 * the post can only show the people who have answered — "who hasn't" arrives
 * with campaign_members in phase 2.
 *
 * The name is the cache in `users`, refreshed on every click; it is a display
 * convenience and never an identity. The id is the identity.
 */
export async function attendanceRows(env: Env, sessionId: string): Promise<AttendanceRow[]> {
  const rows = await db(env)
    .select({
      userId: schema.attendance.userId,
      intent: schema.attendance.intent,
      note: schema.attendance.note,
      username: schema.users.username,
      globalName: schema.users.globalName,
    })
    .from(schema.attendance)
    .leftJoin(schema.users, eq(schema.attendance.userId, schema.users.discordId))
    .where(eq(schema.attendance.sessionId, sessionId))
    .orderBy(asc(schema.attendance.updatedAt), asc(schema.attendance.userId))
    .all();

  return rows.map((row) => ({
    userId: row.userId,
    name: row.globalName ?? row.username ?? `<@${row.userId}>`,
    intent: row.intent,
    note: row.note,
  }));
}
