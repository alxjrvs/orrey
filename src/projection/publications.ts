import { and, eq, sql } from "drizzle-orm";
import type { Env } from "../env.ts";
import { db, schema } from "../db/index.ts";

/**
 * The ledger of what Orrey has put into the world — #73.
 *
 * The shape of the bug this exists for: `projectDiscordEvent` POSTs a scheduled
 * event and *then* writes the id to D1. If that write fails, the queue retries,
 * `discord_event_id` is still null, and a second event goes up with the first
 * one orphaned — up in Discord, with nobody holding its id. `postAttendancePost`
 * has the same window, and under send-only a duplicate post cannot be tidied
 * away afterwards.
 *
 * Google is immune because its id is derived from the session id, so an insert
 * that lands twice lands on the same event. Discord has no equivalent, so this
 * table is the equivalent: **claim before the call, record after it.** A claim
 * is a row saying "someone is already publishing this"; it is written first, so
 * a crash leaves the claim rather than an unrecorded object.
 *
 * The row outlives what it describes. `target_id` is a plain string and there is
 * no cascade, so deleting a session takes nothing here with it and a retraction
 * can still say what to take down.
 */
export interface PublicationRef {
  surface: "discord" | "google";
  kind: "event" | "message" | "thread";
  targetId: string;
  /**
   * Which message about this target. A session has one attendance post but many
   * notices — confirmed, jeopardy, reminders — and each is published once, so
   * each needs its own row rather than sharing the session's.
   *
   * Absent for everything that existed before notices did, so their ids are
   * unchanged: the attendance post is still `discord:message:<sessionId>`.
   */
  label?: string;
}

export type Publication = typeof schema.publications.$inferSelect;

/** Derived, never random: two claims for the same thing collide on the key. */
export function publicationId({ surface, kind, targetId, label }: PublicationRef): string {
  const base = `${surface}:${kind}:${targetId}`;
  return label ? `${base}:${label}` : base;
}

/**
 * What a caller learns before deciding to publish.
 *
 * `mine` is true only for the caller that actually inserted the claim. Anyone
 * else — a redelivered queue message, a re-armed job, the next minute's drain —
 * gets `false` and the row as it stands, and must not publish.
 */
export interface Claim {
  mine: boolean;
  publication: Publication;
}

export async function claim(env: Env, ref: PublicationRef, channelId?: string): Promise<Claim> {
  const id = publicationId(ref);

  // `do nothing` rather than `do update`: the whole value of the claim is that
  // the second caller does not get to overwrite the first one's.
  const inserted = await db(env)
    .insert(schema.publications)
    .values({
      id,
      surface: ref.surface,
      kind: ref.kind,
      targetId: ref.targetId,
      ...(channelId === undefined ? {} : { channelId }),
    })
    .onConflictDoNothing()
    .returning();

  if (inserted.length > 0) return { mine: true, publication: inserted[0] as Publication };

  const existing = await find(env, ref);
  if (!existing) {
    // Inserted by someone else and deleted again between the two statements.
    // Vanishingly unlikely, and a lie if we reported it as our claim.
    throw new Error(`publication ${id} was claimed and then vanished`);
  }
  return { mine: false, publication: existing };
}

/**
 * The remote object exists and this is its id.
 *
 * An insert, not an update: a claim is how the *message* path guards against
 * posting twice, but the event projectors have no such window to guard — their
 * upsert is already idempotent against a known id — and they call this without
 * ever having claimed. An update would silently write nothing for them, which is
 * the whole failure this table exists to prevent.
 */
export async function record(env: Env, ref: PublicationRef, remoteId: string): Promise<void> {
  const published = {
    remoteId,
    state: "published",
    publishedAt: sql`(unixepoch())`,
    retractedAt: null,
    lastError: null,
  } as const;

  await db(env)
    .insert(schema.publications)
    .values({
      id: publicationId(ref),
      surface: ref.surface,
      kind: ref.kind,
      targetId: ref.targetId,
      ...published,
    })
    .onConflictDoUpdate({ target: schema.publications.id, set: published });
}

/**
 * It is down. The row stays, and so does `remote_id` — a retraction is a fact
 * about something that existed, and erasing the id would leave phase 7's
 * reconcile unable to explain what it is looking at.
 */
export async function retract(env: Env, ref: PublicationRef): Promise<void> {
  await db(env)
    .update(schema.publications)
    .set({ state: "retracted", retractedAt: sql`(unixepoch())`, lastError: null })
    .where(eq(schema.publications.id, publicationId(ref)));
}

/**
 * The claim never became anything: Discord answered and refused, so nothing went
 * up and the next attempt should be free to try again. Only ever called where
 * the remote system *answered* — a network error leaves the claim standing,
 * because "we never heard back" and "it did not happen" are not the same thing
 * and only one of them is safe to retry under send-only.
 */
export async function release(env: Env, ref: PublicationRef): Promise<void> {
  await db(env)
    .delete(schema.publications)
    .where(
      and(
        eq(schema.publications.id, publicationId(ref)),
        eq(schema.publications.state, "claimed"),
      ),
    );
}

export async function recordFailure(
  env: Env,
  ref: PublicationRef,
  message: string,
): Promise<void> {
  await db(env)
    .update(schema.publications)
    .set({ lastError: message })
    .where(eq(schema.publications.id, publicationId(ref)));
}

export function find(env: Env, ref: PublicationRef): Promise<Publication | undefined> {
  return db(env)
    .select()
    .from(schema.publications)
    .where(eq(schema.publications.id, publicationId(ref)))
    .get();
}

/**
 * Everything still standing for a target, whether or not the target still
 * exists. This is the read that makes a retraction possible after the session
 * row is gone — which is the common case, not the rare one, because deleting is
 * exactly when the row disappears.
 */
export function standing(env: Env, targetId: string): Promise<Publication[]> {
  return db(env)
    .select()
    .from(schema.publications)
    .where(
      and(
        eq(schema.publications.targetId, targetId),
        eq(schema.publications.state, "published"),
      ),
    )
    .all();
}
