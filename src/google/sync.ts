import { sql } from "drizzle-orm";
import type { Env } from "../env.ts";
import { db, schema } from "../db/index.ts";

/**
 * The trigger for the one path in the system that can loop.
 *
 * A push from Google arms a **job**, not a queue message, for the reason the
 * `jobs` table exists at all: this is the edge where Orrey's own writes can come
 * back to it as somebody else's changes, and when that goes wrong it has to be
 * inspectable and re-runnable by hand.
 *
 * The idempotency key is the minute. A single drag in Google produces a burst of
 * pushes, and they collapse into one sync by the unique constraint on
 * `jobs.idempotency_key` rather than by a lock — which is cheaper, and which
 * works across isolates without one.
 */
export const SYNC_JOB = "gcal.sync";

export async function armSync(env: Env, now = Math.floor(Date.now() / 1000)): Promise<void> {
  const minute = Math.floor(now / 60);
  const id = `${SYNC_JOB}:${minute}`;

  await db(env)
    .insert(schema.jobs)
    .values({
      id,
      kind: SYNC_JOB,
      payload: { minute },
      idempotencyKey: id,
      runAt: sql`(unixepoch())`,
    })
    // Already armed for this minute. A second push in the same minute is the
    // same sync.
    .onConflictDoNothing();
}

/**
 * What the sync job does — nothing, yet.
 *
 * The list call arrives in the PR above this one. The kind is dispatched here so
 * an armed job drains rather than failing with `unknown job kind`, which would
 * fill `last_error` with something nobody needs to read.
 */
export async function runSync(_env: Env): Promise<void> {
  return undefined;
}
