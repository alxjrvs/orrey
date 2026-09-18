import { asc, eq } from "drizzle-orm";
import type { Env } from "../env.ts";
import { db, schema } from "../db/index.ts";
import { SETTING_KEYS, getSetting } from "../db/settings.ts";
import {
  capacityOf,
  seated,
  seatsLeft,
  signupsForDay,
  waitlist,
  type DaySignup,
} from "../game-days/signups.ts";
import { sessionIdFor, type GameDayState } from "../game-days/lifecycle.ts";
import type { RosterEntry } from "./session-detail.ts";

/**
 * One game day, as the console shows it — the campaign page's shape applied to
 * a day.
 *
 * The thing this page has to get right is a constraint from `CLAUDE.md`, and it
 * is the first screen where anybody can actually see it: **signups attach to
 * game days and attendance attaches to the session the day owns. They are two
 * different lists of people.** Somebody can hold a seat and never turn up;
 * somebody can turn up who was on the waitlist all week.
 *
 * So this reads each from its own place and shows both. Merging them into one
 * roster would quietly imply a signup is an intent, which is the shape a page
 * would have to have before anything could try to write a signup against a
 * session id — a write the CHECK constraint would reject, but a page should not
 * be built so that it could attempt it.
 *
 * Nothing here writes, and nothing calls Discord: the links are URLs assembled
 * from ids.
 */
export interface TablePlayed {
  userId: string;
  name: string;
  /** Free text, one line. Null for somebody on the register who has not said. */
  tablesPlayed: string | null;
}

export interface GameDayPage {
  id: string;
  kind: "single" | "multi";
  state: GameDayState;
  /** Where it may go, from the day's own edge map. Empty for PLAYED and CANCELLED. */
  nextStates: GameDayState[];
  startsAt: number;
  endsAt: number;
  title: string | null;
  venue: string | null;
  hostUserId: string | null;
  hostName: string | null;
  gameId: string | null;
  gameName: string | null;
  /**
   * How many seats, or null for "however many turn up". A `single` day takes it
   * from the game unless the day overrides; a `multi` day has no game to ask.
   */
  capacity: number | null;
  seatsLeft: number | null;
  /** Who holds a place. From `signups`, which hangs off the **day**. */
  seated: DaySignup[];
  /** Who is behind them, in `signups.position` order. */
  waitlist: DaySignup[];
  /**
   * Who said they were coming and who came. From `attendance`, which hangs off
   * the **session** the day owns. Not the same list as the signups above.
   */
  register: RosterEntry[];
  /**
   * What each person played, on a day where several tables ran.
   *
   * Null for a `single` day, which has one table and therefore nothing to
   * record, and null before the day is `PLAYED` — the question is what somebody
   * *did* play, and asking it of a day that has not happened has no answer.
   */
  tables: TablePlayed[] | null;
  threadUrl: string | null;
  postUrl: string | null;
}

const EDGES: Record<GameDayState, readonly GameDayState[]> = {
  PROPOSED: ["SEATING", "CANCELLED"],
  SEATING: ["LOCKED", "CANCELLED"],
  LOCKED: ["PLAYED", "CANCELLED"],
  PLAYED: [],
  CANCELLED: [],
};

export async function gameDayPage(env: Env, gameDayId: string): Promise<GameDayPage | undefined> {
  const row = await db(env)
    .select({ day: schema.gameDays, game: schema.games })
    .from(schema.gameDays)
    .leftJoin(schema.games, eq(schema.gameDays.gameId, schema.games.id))
    .where(eq(schema.gameDays.id, gameDayId))
    .get();
  if (!row) return undefined;

  const { day, game } = row;
  const guildId = await getSetting<string>(env, SETTING_KEYS.guildId);

  // Two reads, from two tables, keyed on two different ids. That is the point.
  const signups = await signupsForDay(env, gameDayId);
  const register = await registerFor(env, sessionIdFor(gameDayId));

  const capacity = await capacityOf(env, gameDayId);

  return {
    id: day.id,
    kind: day.kind,
    state: day.state,
    nextStates: [...EDGES[day.state]],
    startsAt: day.startsAt,
    endsAt: day.endsAt,
    title: day.title,
    venue: day.venue,
    hostUserId: day.hostUserId,
    hostName: day.hostUserId ? await nameOf(env, day.hostUserId) : null,
    gameId: day.gameId,
    gameName: game?.name ?? null,
    capacity,
    seatsLeft: seatsLeft(capacity, signups),
    seated: seated(signups),
    waitlist: waitlist(signups),
    register: register.map(({ tablesPlayed: _ignored, ...entry }) => entry),
    // A `single` day has one table, so there is nothing to record. And before
    // the day is PLAYED the question has no answer: what somebody *did* play is
    // not a thing to ask of an evening that has not happened.
    tables:
      day.kind === "multi" && day.state === "PLAYED"
        ? register.map((entry) => ({
            userId: entry.userId,
            name: entry.name,
            tablesPlayed: entry.tablesPlayed,
          }))
        : null,
    threadUrl:
      guildId && day.threadId ? `https://discord.com/channels/${guildId}/${day.threadId}` : null,
    postUrl:
      guildId && day.discordChannelId && day.discordMessageId
        ? `https://discord.com/channels/${guildId}/${day.discordChannelId}/${day.discordMessageId}`
        : null,
  };
}

/**
 * The register — the same `RosterEntry` shape the session rail uses, because it
 * is the same question — plus the line each person wrote about what they played.
 */
interface RegisterRow extends RosterEntry {
  tablesPlayed: string | null;
}

async function registerFor(env: Env, sessionId: string): Promise<RegisterRow[]> {
  const rows = await db(env)
    .select({
      userId: schema.attendance.userId,
      intent: schema.attendance.intent,
      attended: schema.attendance.attended,
      attendedSource: schema.attendance.attendedSource,
      tablesPlayed: schema.attendance.tablesPlayed,
      note: schema.attendance.note,
      username: schema.users.username,
      globalName: schema.users.globalName,
    })
    .from(schema.attendance)
    .leftJoin(schema.users, eq(schema.attendance.userId, schema.users.discordId))
    .where(eq(schema.attendance.sessionId, sessionId))
    .orderBy(asc(schema.attendance.userId))
    .all();

  return rows.map((row) => ({
    userId: row.userId,
    name: row.globalName ?? row.username ?? `<@${row.userId}>`,
    intent: row.intent,
    // Null is not false. Nobody wrote the register is not the same answer as
    // they did not turn up.
    attended: row.attended === null ? null : row.attended === 1,
    corrected: row.attendedSource === "gm",
    note: row.note,
    tablesPlayed: row.tablesPlayed,
  }));
}

async function nameOf(env: Env, userId: string): Promise<string> {
  const row = await db(env)
    .select({ username: schema.users.username, globalName: schema.users.globalName })
    .from(schema.users)
    .where(eq(schema.users.discordId, userId))
    .get();
  return row?.globalName ?? row?.username ?? `<@${userId}>`;
}
