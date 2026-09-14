import { and, asc, eq, sql } from "drizzle-orm";
import type { Env } from "../env.ts";
import { db, schema } from "../db/index.ts";
import { capacityOf, signupsForDay } from "./signups.ts";

/**
 * A seat came free, so somebody comes in off the waitlist.
 *
 * **A promotion is a state change, not a renumber.** The promoted row keeps the
 * `position` it arrived at and becomes `in`. That is what makes this safe to run
 * again: a second call finds a full table and promotes nobody, so a retried job
 * — or a redelivery, or `p5/10`'s lock running it once more on the way past — is
 * a no-op rather than a second person shuffled in.
 *
 * It is called from inside the same serialised chain that freed the seat, and
 * that is not decoration. Two people going Out at once, outside the lock, both
 * read "one seat free" and both promote the head of the queue — one seat, two
 * people, and the second one's row already said `in`.
 *
 * A day with no capacity has no waitlist to promote from: everybody who claims a
 * place is seated the moment they claim it.
 */
export const PROMOTED_JOB = "game-day.promoted";

export interface Promotion {
  userId: string;
  position: number | null;
}

export async function promoteFromWaitlist(
  env: Env,
  gameDayId: string,
): Promise<Promotion[]> {
  const capacity = await capacityOf(env, gameDayId);
  if (capacity === null) return [];

  const signups = await signupsForDay(env, gameDayId);
  const seated = signups.filter((signup) => signup.state === "in").length;
  const free = capacity - seated;
  if (free <= 0) return [];

  // Lowest position first, which is arrival order — the queue, in the order it
  // formed. Ties on a null position fall back to the user id so the answer is
  // the same on every run rather than whatever SQLite felt like.
  const queued = signups
    .filter((signup) => signup.state === "waitlisted")
    .slice(0, free)
    .map((signup) => ({ userId: signup.userId, position: signup.position }));

  if (queued.length === 0) return [];

  const d = db(env);
  const noticeId = crypto.randomUUID();
  const [first, ...rest] = queued.map((promotion) =>
    d
      .update(schema.signups)
      .set({ state: "in", updatedAt: sql`(unixepoch())` })
      .where(
        and(
          eq(schema.signups.targetType, "game_day"),
          eq(schema.signups.targetId, gameDayId),
          eq(schema.signups.userId, promotion.userId),
          // Still waitlisted. Belt and braces inside the lock, and the thing
          // that makes a replay outside it harmless.
          eq(schema.signups.state, "waitlisted"),
        ),
      ),
  );

  await d.batch([
    first!,
    ...rest,
    // The notice is a job rather than a post made here, for the reason the
    // confirmed notice gives: a click has three seconds to answer and the thing
    // that must happen inside them is the rewrite of its own message. A second
    // Discord call spends them on something the drain can do a minute later.
    //
    // The payload carries who moved, because by the time the drain runs they are
    // simply seated and indistinguishable from everybody else at the table.
    d.insert(schema.jobs).values({
      id: `${PROMOTED_JOB}:${gameDayId}:${noticeId}`,
      kind: PROMOTED_JOB,
      // `noticeId` is what the notice is claimed under, and it is minted per
      // promotion rather than derived from who moved. Somebody promoted, going
      // Out and being promoted again is two notices, and a label made of their
      // id would let the first one's claim swallow the second.
      payload: { gameDayId, noticeId, userIds: queued.map((promotion) => promotion.userId) },
      idempotencyKey: `${PROMOTED_JOB}:${gameDayId}:${noticeId}`,
      runAt: sql`(unixepoch())`,
    }),
  ]);

  return queued;
}

/** Who is next, without moving anybody. For the console, and for the tests. */
export async function nextUp(env: Env, gameDayId: string): Promise<Promotion | undefined> {
  const row = await db(env)
    .select({ userId: schema.signups.userId, position: schema.signups.position })
    .from(schema.signups)
    .where(
      and(
        eq(schema.signups.targetType, "game_day"),
        eq(schema.signups.targetId, gameDayId),
        eq(schema.signups.state, "waitlisted"),
      ),
    )
    .orderBy(asc(schema.signups.position), asc(schema.signups.userId))
    .get();

  return row ?? undefined;
}
