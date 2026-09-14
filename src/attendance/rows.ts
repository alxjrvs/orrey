import { asc, eq } from "drizzle-orm";
import type { Env } from "../env.ts";
import { db, schema } from "../db/index.ts";
import { rosterOf } from "../campaigns/roster.ts";
import type { AttendanceRow } from "./render.ts";

/**
 * Who has said what, in the order they said it — and, since phase 2, who has not
 * said anything at all.
 *
 * The roster is the second half of the question the post asks. "Four in" reads
 * very differently when the campaign has five players than when it has nine, and
 * until `campaign_members` existed the post could only show the people who had
 * answered. It can now show the silence too.
 *
 * Silence is not a "no". Anyone on the roster who has not answered comes back
 * with a null intent, exactly like somebody who has a row but has not chosen —
 * the renderer is what decides how that reads, and it never reads as "out".
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

  const answered: AttendanceRow[] = rows.map((row) => ({
    userId: row.userId,
    name: row.globalName ?? row.username ?? `<@${row.userId}>`,
    intent: row.intent,
    note: row.note,
  }));

  const campaignId = await campaignOf(env, sessionId);
  if (!campaignId) return answered;

  // Anyone already holding a row is already in the list, whatever they said —
  // including somebody who has since left the roster, because they answered and
  // that answer is still true of them.
  const heard = new Set(answered.map((row) => row.userId));
  const silent = (await rosterOf(env, campaignId))
    .filter((member) => !heard.has(member.userId))
    .map((member) => ({
      userId: member.userId,
      name: member.name,
      intent: null,
      note: null,
    }));

  return [...answered, ...silent];
}

/** A one-off has no roster to be silent. */
async function campaignOf(env: Env, sessionId: string): Promise<string | undefined> {
  const row = await db(env)
    .select({ campaignId: schema.sessions.campaignId })
    .from(schema.sessions)
    .where(eq(schema.sessions.id, sessionId))
    .get();
  return row?.campaignId ?? undefined;
}
