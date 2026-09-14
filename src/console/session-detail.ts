import { asc, eq } from "drizzle-orm";
import type { Env } from "../env.ts";
import { db, schema } from "../db/index.ts";
import { SETTING_KEYS, getSetting } from "../db/settings.ts";
import { attendanceRows } from "../attendance/rows.ts";
import { quorumOf, type Quorum } from "../attendance/quorum.ts";
import { loadProjectionTarget, sessionTitle } from "../projection/target.ts";

/**
 * One session, as the console shows it.
 *
 * The design puts this in a 300px rail beside the agenda rather than on a page
 * of its own, and the month grid clicks through to the same rail. So this is
 * shaped for a rail: everything about one session, all at once, read-only.
 *
 * **Nothing here calls Discord or Google.** The links are URLs assembled from
 * ids, never a fetch, and the sync state is what `calendar_links` says with the
 * timestamp it says it at. Orrey's database is the source of truth and the
 * projector is what writes that row; a console that asked Google would be
 * showing a projection as though it were the thing projected.
 */
export interface RosterEntry {
  userId: string;
  name: string;
  /** What they said. Null is "not heard from", which is never the same as out. */
  intent: "in" | "out" | "maybe" | null;
  /**
   * Whether they came. Null until the register is written — which is most of the
   * time, because it is written when the session ends.
   */
  attended: boolean | null;
  /** Whether a person decided that, as opposed to Orrey having assumed it. */
  corrected: boolean;
  note: string | null;
}

/**
 * Projection state is **ambient**, which is why the design puts it in the rail
 * rather than behind a button: it is a thing to glance at, not a thing to ask
 * for.
 */
export type SyncState = "not-projected" | "synced" | "failing";

export interface SessionDetail {
  sessionId: string;
  title: string;
  startsAt: number;
  endsAt: number;
  state: string;
  location: string | null;
  campaignId: string | null;
  gameDayId: string | null;
  quorum: Quorum;
  roster: RosterEntry[];
  /** A link to the thread, or nothing. Never a reason to call Discord. */
  threadUrl: string | null;
  /**
   * A link to the scheduled event, or nothing.
   *
   * `sessions.discord_event_id` is **losable**: a lapsed event is replaced
   * rather than revived, so this going null is expected behaviour and not a
   * failure. Nothing here dresses it up as one.
   */
  eventUrl: string | null;
  sync: {
    state: SyncState;
    syncedAt: number | null;
    lastError: string | null;
  };
}

export async function sessionDetail(
  env: Env,
  sessionId: string,
): Promise<SessionDetail | undefined> {
  const target = await loadProjectionTarget(env, sessionId);
  if (!target) return undefined;

  const { session } = target;
  const rows = await attendanceRows(env, sessionId);
  const guildId = await getSetting<string>(env, SETTING_KEYS.guildId);

  const link = await db(env)
    .select()
    .from(schema.calendarLinks)
    .where(eq(schema.calendarLinks.sessionId, sessionId))
    .get();

  return {
    sessionId,
    title: sessionTitle(target),
    startsAt: session.startsAt,
    endsAt: session.endsAt,
    state: session.state,
    location: session.location ?? target.gameDay?.venue ?? null,
    campaignId: session.campaignId,
    gameDayId: session.gameDayId,
    quorum: quorumOf(target, rows),
    roster: await rosterFor(env, sessionId, rows),
    threadUrl:
      guildId && session.threadId
        ? `https://discord.com/channels/${guildId}/${session.threadId}`
        : null,
    eventUrl:
      guildId && session.discordEventId
        ? `https://discord.com/events/${guildId}/${session.discordEventId}`
        : null,
    sync: syncStateOf(link),
  };
}

/**
 * The roster with `intent` and `attended` side by side.
 *
 * Exported because `p6/5-campaign-page` forks off this branch to reuse it rather
 * than cutting a second shaping — one row per member, with no reply
 * distinguished from out, is the thing both pages have to get right.
 */
export async function rosterFor(
  env: Env,
  sessionId: string,
  rows?: Awaited<ReturnType<typeof attendanceRows>>,
): Promise<RosterEntry[]> {
  const said = rows ?? (await attendanceRows(env, sessionId));

  const register = await db(env)
    .select({
      userId: schema.attendance.userId,
      attended: schema.attendance.attended,
      attendedSource: schema.attendance.attendedSource,
    })
    .from(schema.attendance)
    .where(eq(schema.attendance.sessionId, sessionId))
    .orderBy(asc(schema.attendance.userId))
    .all();

  const by = new Map(register.map((row) => [row.userId, row]));

  return said.map((row) => {
    const mark = by.get(row.userId);
    return {
      userId: row.userId,
      name: row.name,
      intent: row.intent,
      // Null, not false. "Did not come" and "nobody has written the register
      // yet" are different answers and the rail shows them differently.
      attended: mark?.attended === null || mark?.attended === undefined ? null : mark.attended === 1,
      corrected: mark?.attendedSource === "gm",
      note: row.note,
    };
  });
}

/**
 * What the row says, not what Google says.
 *
 * A session with no `calendar_links` row has not been projected — which is an
 * ordinary state, not an error. A row whose `last_error` is set and whose
 * `synced_at` is older than the attempt is failing. Everything else is synced.
 */
export function syncStateOf(
  link: { syncedAt: number | null; lastError: string | null } | undefined,
): { state: SyncState; syncedAt: number | null; lastError: string | null } {
  if (!link) return { state: "not-projected", syncedAt: null, lastError: null };
  if (link.lastError) {
    return { state: "failing", syncedAt: link.syncedAt, lastError: link.lastError };
  }
  return { state: "synced", syncedAt: link.syncedAt, lastError: null };
}
