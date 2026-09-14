import { asc, eq, inArray, sql } from "drizzle-orm";
import type { Env } from "../env.ts";
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

export async function mintGameDays(env: Env, pollId: string, wonIds: string[]): Promise<string[]> {
  if (wonIds.length === 0) return [];

  const poll = await db(env)
    .select()
    .from(schema.datePolls)
    .where(eq(schema.datePolls.id, pollId))
    .get();
  if (!poll) return [];

  const dates = await db(env)
    .select()
    .from(schema.pollDates)
    .where(inArray(schema.pollDates.id, wonIds))
    .orderBy(asc(schema.pollDates.startsAt))
    .all();

  // Already minted. A redelivery or a second Apply finds the link written and
  // does nothing, rather than producing a second Saturday.
  const fresh = dates.filter((date) => date.gameDayId === null);
  if (fresh.length === 0) return dates.map((date) => date.gameDayId!).filter(Boolean);

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

  await d.batch([
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
  ]);

  return minted.map(({ dayId }) => dayId);
}
