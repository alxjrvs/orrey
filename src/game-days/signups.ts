import { and, asc, eq, sql } from "drizzle-orm";
import type { Env } from "../env.ts";
import { db, schema } from "../db/index.ts";

/**
 * Claiming a place at a game day.
 *
 * The table this writes to is phase 2's. **Nothing here is a migration**, and
 * that is worth saying out loud because the plan for this slice assumed one: it
 * expected `signups.target_type` to be widened from `campaign_forming` to
 * include `game_day`, which on SQLite means rebuilding the table that carries
 * `signups_target_ck` — the CHECK enforcing `CLAUDE.md`'s "signups attach to
 * campaigns at formation and to game days — never to an individual session".
 *
 * Phase 2 saw that coming and wrote both values into the constraint on the day
 * it created the table, with a comment saying why. So the invariant this PR was
 * most likely to break is one it does not touch: the CHECK is byte-for-byte what
 * `0006_roster_and_audit.sql` created, `state` already reads
 * `in | waitlisted | out`, and `(target_type, target_id, user_id)` is already the
 * primary key. What phase 5 adds is the code that writes the second kind of row.
 *
 * ## Seated or waitlisted, and the order
 *
 * `state` says which side of the line somebody is on; `position` says where they
 * arrived. Splitting it that way is what makes promotion cheap — the head of the
 * waitlist becomes seated by changing one column, with nothing renumbered — so
 * replaying a promotion is a no-op and two of them racing cannot interleave into
 * a gap.
 *
 * Phase 2 described `position` as "waitlist order, null for anyone not on the
 * waitlist". Phase 5 is the phase that reads it, and reads it as **arrival order
 * within a target**: set for everyone who claims a place at a day, seated or
 * not, and never touched again while the claim stands. Under phase 2's reading,
 * promoting somebody would have to blank their position and seating somebody
 * would have to decide not to give them one; under this one, promotion is the
 * single state change the paragraph above wants, and a withdrawal never
 * renumbers anybody. A forming campaign has no capacity and therefore no queue,
 * so its signups still leave `position` null.
 *
 * ## Why the claim is one statement
 *
 * Two people clicking at once, on a day with one seat left, must not both get
 * it. Reading the seated count and then inserting would let exactly that happen,
 * and this phase has no lock of its own until `p5/10` — which locks the table
 * for a different reason and is far too late to be the thing that makes seating
 * correct.
 *
 * So the count, the position and the seated-or-waitlisted decision are all
 * expressions *inside* the INSERT. D1 runs one statement atomically, so the two
 * clicks serialise: whichever reaches the database second sees the first one's
 * row in its own subquery and is waitlisted. No lock, no read-modify-write, and
 * nothing to replay wrong.
 */
const TARGET = "game_day" as const;

export type SignupState = (typeof schema.signups.$inferSelect)["state"];

export interface SeatClaim {
  /**
   * `unchanged` is a second click, not an error: somebody who already holds a
   * place or a queue position keeps exactly the one they had.
   */
  outcome: "seated" | "waitlisted" | "unchanged" | "no-such-day" | "not-seating";
  /** Where they stand now, or null when nothing was written. */
  state: SignupState | null;
  position: number | null;
}

/**
 * How many seats a day has, or null for "however many turn up".
 *
 * A `single` day takes its count from the game unless the day overrides it —
 * the evening the table only has five chairs. A `multi` day has no game to ask,
 * so its capacity is its own column or nothing.
 */
export async function capacityOf(env: Env, gameDayId: string): Promise<number | null> {
  const day = await dayWithCapacity(env, gameDayId);
  return day ? day.capacity : null;
}

export interface ClaimOptions {
  characterName?: string | null | undefined;
  /**
   * `waitlist` is somebody choosing the queue while there are still seats —
   * "I'll come if you need me". `seat` takes one if there is one and queues if
   * there is not, so **Take a seat** on a full day and **Waitlist** land in the
   * same place and the post they get back says which.
   */
  prefer?: "seat" | "waitlist" | undefined;
}

export async function claimSeat(
  env: Env,
  gameDayId: string,
  userId: string,
  options: ClaimOptions = {},
): Promise<SeatClaim> {
  const characterName = options.characterName ?? null;
  const day = await dayWithCapacity(env, gameDayId);
  if (!day) return { outcome: "no-such-day", state: null, position: null };

  // Fails closed. A day nobody has opened seating on is not one people can claim
  // a place at, and neither is a locked, played or cancelled one — the whole
  // point of LOCKED is that the table has stopped moving.
  if (day.state !== "SEATING") return { outcome: "not-seating", state: null, position: null };

  const existing = await signupOf(env, gameDayId, userId);
  if (existing && existing.state !== "out") {
    // Their place is already theirs. A repeated click may still be carrying a
    // character name they have only just filled in, and that is worth keeping.
    if (characterName !== null && characterName !== existing.characterName) {
      await db(env)
        .update(schema.signups)
        .set({ characterName, updatedAt: sql`(unixepoch())` })
        .where(claimant(gameDayId, userId));
    }
    return { outcome: "unchanged", state: existing.state, position: existing.position };
  }

  const d = db(env);
  await d
    .insert(schema.signups)
    .values({
      targetType: TARGET,
      targetId: gameDayId,
      userId,
      state: options.prefer === "waitlist" ? sql`'waitlisted'` : seatOrQueue(gameDayId, day.capacity),
      position: nextPosition(gameDayId),
      characterName,
    })
    .onConflictDoUpdate({
      target: [schema.signups.targetType, schema.signups.targetId, schema.signups.userId],
      set: {
        // Only somebody who had withdrawn is moved. `excluded` carries the
        // values the INSERT computed a moment ago, so coming back puts them at
        // the back of the queue rather than restoring the place they gave up.
        state: sql`CASE WHEN ${schema.signups.state} = 'out' THEN excluded.state ELSE ${schema.signups.state} END`,
        position: sql`CASE WHEN ${schema.signups.state} = 'out' THEN excluded.position ELSE ${schema.signups.position} END`,
        characterName: sql`COALESCE(excluded.character_name, ${schema.signups.characterName})`,
        updatedAt: sql`(unixepoch())`,
      },
    });

  // Read back rather than predict: the whole reason the decision is an
  // expression is that another claim may have landed between composing this
  // statement and running it, and the row is the only thing that knows.
  const row = await signupOf(env, gameDayId, userId);
  return {
    outcome: row?.state === "in" ? "seated" : "waitlisted",
    state: row?.state ?? null,
    position: row?.position ?? null,
  };
}

/**
 * Giving the place back.
 *
 * The row stays, holding `out` and the position they arrived at. Deleting it
 * would make "claimed and withdrew" indistinguishable from "never claimed", and
 * the position is what makes a re-claim land behind everyone who has since
 * arrived instead of in front of them.
 *
 * Nothing is promoted here. A seat coming free is `p5/7`'s to notice, and doing
 * it in the same breath as the withdrawal would put a Discord post inside a
 * click handler that has not finished answering yet.
 */
export async function withdraw(
  env: Env,
  gameDayId: string,
  userId: string,
): Promise<"withdrawn" | "not-claimed"> {
  const existing = await signupOf(env, gameDayId, userId);
  if (!existing || existing.state === "out") return "not-claimed";

  await db(env)
    .update(schema.signups)
    .set({ state: "out", updatedAt: sql`(unixepoch())` })
    .where(claimant(gameDayId, userId));

  return "withdrawn";
}

export interface DaySignup {
  userId: string;
  /** The cache in `users`, never the identity. Falls back to a mention. */
  name: string;
  state: SignupState;
  position: number | null;
  characterName: string | null;
}

/**
 * Everybody with a live claim on this day, in arrival order — the seated first
 * because they arrived first, then the queue behind them.
 *
 * Withdrawals are not in it. They are history, and this is the answer to "who is
 * coming".
 */
export async function signupsForDay(env: Env, gameDayId: string): Promise<DaySignup[]> {
  const rows = await db(env)
    .select({
      userId: schema.signups.userId,
      state: schema.signups.state,
      position: schema.signups.position,
      characterName: schema.signups.characterName,
      username: schema.users.username,
      globalName: schema.users.globalName,
    })
    .from(schema.signups)
    .leftJoin(schema.users, eq(schema.signups.userId, schema.users.discordId))
    .where(
      and(
        eq(schema.signups.targetType, TARGET),
        eq(schema.signups.targetId, gameDayId),
        sql`${schema.signups.state} <> 'out'`,
      ),
    )
    .orderBy(asc(schema.signups.position), asc(schema.signups.userId))
    .all();

  return rows.map((row) => ({
    userId: row.userId,
    name: row.globalName ?? row.username ?? `<@${row.userId}>`,
    state: row.state,
    position: row.position,
    characterName: row.characterName,
  }));
}

/** Who is at the table. */
export function seated(signups: DaySignup[]): DaySignup[] {
  return signups.filter((signup) => signup.state === "in");
}

/** Who is behind it, in the order they would come in. */
export function waitlist(signups: DaySignup[]): DaySignup[] {
  return signups.filter((signup) => signup.state === "waitlisted");
}

/** Seats left, or null when there is no number to count down from. */
export function seatsLeft(capacity: number | null, signups: DaySignup[]): number | null {
  return capacity === null ? null : Math.max(0, capacity - seated(signups).length);
}

function claimant(gameDayId: string, userId: string) {
  return and(
    eq(schema.signups.targetType, TARGET),
    eq(schema.signups.targetId, gameDayId),
    eq(schema.signups.userId, userId),
  );
}

function signupOf(env: Env, gameDayId: string, userId: string) {
  return db(env).select().from(schema.signups).where(claimant(gameDayId, userId)).get();
}

async function dayWithCapacity(env: Env, gameDayId: string) {
  const row = await db(env)
    .select({
      state: schema.gameDays.state,
      capacity: schema.gameDays.capacity,
      maxPlayers: schema.games.maxPlayers,
    })
    .from(schema.gameDays)
    .leftJoin(schema.games, eq(schema.gameDays.gameId, schema.games.id))
    .where(eq(schema.gameDays.id, gameDayId))
    .get();

  if (!row) return undefined;
  return { state: row.state, capacity: row.capacity ?? row.maxPlayers ?? null };
}

/** How many are seated *right now*, evaluated by SQLite inside the INSERT. */
function seatedCount(gameDayId: string) {
  return sql`(SELECT COUNT(*) FROM ${schema.signups}
     WHERE ${schema.signups.targetType} = ${TARGET}
       AND ${schema.signups.targetId} = ${gameDayId}
       AND ${schema.signups.state} = 'in')`;
}

function seatOrQueue(gameDayId: string, capacity: number | null) {
  if (capacity === null) return sql`'in'`;
  return sql`(CASE WHEN ${seatedCount(gameDayId)} < ${capacity} THEN 'in' ELSE 'waitlisted' END)`;
}

/** One past the furthest anybody has arrived, withdrawals included. */
function nextPosition(gameDayId: string) {
  return sql`(SELECT COALESCE(MAX(${schema.signups.position}), 0) + 1 FROM ${schema.signups}
     WHERE ${schema.signups.targetType} = ${TARGET}
       AND ${schema.signups.targetId} = ${gameDayId})`;
}
