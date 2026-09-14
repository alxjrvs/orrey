import { asc, eq, inArray, sql } from "drizzle-orm";
import type { Env } from "../env.ts";
import type { BatchItem } from "drizzle-orm/batch";
import { db, schema } from "../db/index.ts";
import { mintId } from "../db/ids.ts";

/**
 * One day per winning date.
 *
 * A multi-kind poll can win more than one date, and then this is more than one
 * day — which is the case #37 is written around: "Saturday and Sunday both work
 * and we will run both."
 *
 * The mint happens inside the same batch that writes the outcomes, so a poll
 * cannot end up closed with winners and no days. A second Apply on a closed poll
 * is already refused, which is what stops a second Saturday appearing.
 *
 * A PROPOSED day has no capacity, no host and no signup buttons. Those are phase
 * 5's, and the announcement says only that the day exists.
 */
export const ANNOUNCE_JOB = "gameday.announce";

/**
 * The statements that mint the days, for a caller to put in **its own** batch.
 *
 * Split out from `mintGameDays` because this file's own claim — "the mint
 * happens inside the same batch that writes the outcomes, so a poll cannot end
 * up closed with winners and no days" — was not true of the code: the close
 * committed in one batch and this ran in another. A crash, an eviction or a D1
 * error in between left a poll permanently closed with winning dates and no day,
 * and no retry, because Apply's own guard refuses a closed poll.
 *
 * Nothing here talks to Discord, so unlike a session move there is no reason for
 * it to be a job. The reads happen first and the writes go back to the caller,
 * which is what lets the claim be true.
 */
export async function mintStatements(env: Env, pollId: string, wonIds: string[]) {
  const empty = { statements: [] as BatchItem<"sqlite">[], dayIds: [] as string[] };
  if (wonIds.length === 0) return empty;

  const poll = await db(env)
    .select()
    .from(schema.datePolls)
    .where(eq(schema.datePolls.id, pollId))
    .get();
  if (!poll) return empty;

  const dates = await db(env)
    .select()
    .from(schema.pollDates)
    .where(inArray(schema.pollDates.id, wonIds))
    .orderBy(asc(schema.pollDates.startsAt))
    .all();

  // Already minted. A redelivery or a second Apply finds the link written and
  // does nothing, rather than producing a second Saturday.
  const fresh = dates.filter((date) => date.gameDayId === null);
  if (fresh.length === 0) {
    return { statements: [], dayIds: dates.map((date) => date.gameDayId!).filter(Boolean) };
  }

  const title = poll.gameId
    ? ((
        await db(env)
          .select({ name: schema.games.name })
          .from(schema.games)
          .where(eq(schema.games.id, poll.gameId))
          .get()
      )?.name ?? null)
    : null;

  const d = db(env);
  const minted = fresh.map((date) => ({ dayId: mintId(), date }));

  const statements: BatchItem<"sqlite">[] = [
    d.insert(schema.gameDays).values(
      minted.map(({ dayId, date }) => ({
        id: dayId,
        kind: poll.gameDayKind ?? ("single" as const),
        startsAt: date.startsAt,
        endsAt: date.endsAt,
        title,
      })),
    ),
    ...minted.map(({ dayId, date }) =>
      d
        .update(schema.pollDates)
        .set({ gameDayId: dayId })
        .where(eq(schema.pollDates.id, date.id)),
    ),
    d.insert(schema.jobs).values(
      minted.map(({ dayId }) => ({
        id: `${ANNOUNCE_JOB}:${dayId}`,
        kind: ANNOUNCE_JOB,
        payload: { gameDayId: dayId },
        idempotencyKey: `${ANNOUNCE_JOB}:${dayId}`,
        runAt: sql`(unixepoch())`,
      })),
    ),
  ];

  return { statements, dayIds: minted.map(({ dayId }) => dayId) };
}

/** Mint them on their own, for a caller with no batch of its own to join. */
export async function mintGameDays(env: Env, pollId: string, wonIds: string[]): Promise<string[]> {
  const { statements, dayIds } = await mintStatements(env, pollId, wonIds);
  const [first, ...rest] = statements;
  if (first) await db(env).batch([first, ...rest]);
  return dayIds;
}
