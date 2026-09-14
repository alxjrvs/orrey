import { sql } from "drizzle-orm";
import { schema, type Db } from "../db/index.ts";

/**
 * A standing job, described rather than written.
 *
 * The arming sites all want the same row shape and for the same reason: one per
 * session per kind, re-armed rather than duplicated, because a session that
 * moves takes its whole ladder with it. What they do *not* all want is their own
 * round trip — a state change and the jobs it enables have to commit together,
 * or a transient D1 error between them leaves a day that can never finish and a
 * retry that short-circuits on the state it just wrote. Describing the row and
 * letting the caller decide where the statement goes is what makes that
 * possible.
 */
export interface ArmedJob {
  id: string;
  kind: string;
  payload: Record<string, unknown>;
  runAt: number;
}

/**
 * One statement, however many rows.
 *
 * `excluded.run_at` is what lets the re-arm be a single multi-row upsert rather
 * than one per job: each row carries its own new time and the conflict clause
 * takes that row's, rather than a value fixed when the statement was composed.
 * The rest of the set is the same everywhere — a moved session is a pending job
 * with its old failure forgotten.
 */
export function rearmStatement(d: Db, jobs: ArmedJob[]) {
  return d
    .insert(schema.jobs)
    .values(jobs.map((job) => ({ ...job, idempotencyKey: job.id })))
    .onConflictDoUpdate({
      target: schema.jobs.id,
      set: {
        runAt: sql`excluded.run_at`,
        state: "pending",
        attempts: 0,
        lastError: null,
      },
    });
}

/** The same thing, written now, for the callers that are a round trip of their own. */
export async function rearm(d: Db, jobs: ArmedJob[]): Promise<void> {
  if (jobs.length === 0) return;
  await rearmStatement(d, jobs);
}
