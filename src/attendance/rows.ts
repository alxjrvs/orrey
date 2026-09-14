import { asc, eq } from "drizzle-orm";
import type { Env } from "../env.ts";
import { db, schema } from "../db/index.ts";
import { rosterOf } from "../campaigns/roster.ts";
import { signupsForDay } from "../game-days/signups.ts";
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

  // Anyone already holding a row is already in the list, whatever they said —
  // including somebody who has since left the roster, because they answered and
  // that answer is still true of them.
  const heard = new Set(answered.map((row) => row.userId));
  const silent = (await rosterFor(env, sessionId))
    .filter((member) => !heard.has(member.userId))
    .map((member) => ({
      userId: member.userId,
      name: member.name,
      intent: null,
      note: null,
    }));

  return [...answered, ...silent];
}

/**
 * Who this session is for — asked of whichever parent it has.
 *
 * A campaign session's roster is `campaign_members`, or the claimants while it
 * is still forming; `rosterOf` has answered that since phase 2. A game day's is
 * **the seated signups**, and only those: the waitlist is the queue behind the
 * table, not the table, and listing somebody who has not got a seat as "not
 * heard from" would be asking them a question nobody put to them.
 *
 * That is the whole of the roster handoff, and it is why a game day needs no
 * attendance machinery of its own. Everything above this — the post, the five
 * buttons, the reminder ladder, the jeopardy check, the assume job — reads
 * `attendanceRows` and none of them has to learn what a game day is.
 */
async function rosterFor(
  env: Env,
  sessionId: string,
): Promise<{ userId: string; name: string }[]> {
  const row = await db(env)
    .select({
      campaignId: schema.sessions.campaignId,
      gameDayId: schema.sessions.gameDayId,
    })
    .from(schema.sessions)
    .where(eq(schema.sessions.id, sessionId))
    .get();

  if (row?.campaignId) return rosterOf(env, row.campaignId);
  if (row?.gameDayId) {
    const signups = await signupsForDay(env, row.gameDayId);
    return signups.filter((signup) => signup.state === "in");
  }
  // A session with neither parent has no roster to be silent.
  return [];
}
