import { eq, sql } from "drizzle-orm";
import type { Env } from "../env.ts";
import { db, schema } from "../db/index.ts";

/**
 * A winning date that is an anchor rather than a day.
 *
 * The "find the slot" case: a campaign that has not started yet asks when it
 * could run, and the date that wins becomes `campaigns.recurrence_anchor`. The
 * horizon materialiser takes it from there on the next hourly tick and the
 * campaign's first sessions appear without anyone entering a date.
 *
 * **Which branch a poll takes is decided by the campaign's state and nothing
 * else**, and a poll cannot take both: a FORMING campaign's poll sets an anchor,
 * a RUNNING one's mints days, because a running campaign already has its slot.
 *
 * The anchor may sit in the past by design — phase 2's recurrence is an anchor
 * plus an interval, and the anchor is where the count starts rather than when
 * the next session is. So nothing here rejects a winning date for being early.
 */
export type AnchorResult = "anchored" | "too-many" | "not-forming";

export async function anchorFrom(
  env: Env,
  campaignId: string,
  wonIds: string[],
): Promise<AnchorResult> {
  const campaign = await db(env)
    .select({ state: schema.campaigns.state })
    .from(schema.campaigns)
    .where(eq(schema.campaigns.id, campaignId))
    .get();

  if (!campaign || campaign.state !== "FORMING") return "not-forming";

  /**
   * One winner only. An anchor is a single date by definition, so a rule that
   * returned a tie is resolved in the override view — the organiser picks one —
   * rather than the code silently taking the first and calling it the slot.
   */
  if (wonIds.length !== 1) return "too-many";

  const date = await db(env)
    .select({ startsAt: schema.pollDates.startsAt })
    .from(schema.pollDates)
    .where(eq(schema.pollDates.id, wonIds[0] as string))
    .get();
  if (!date) return "too-many";

  await db(env)
    .update(schema.campaigns)
    .set({ recurrenceAnchor: date.startsAt, updatedAt: sql`(unixepoch())` })
    .where(eq(schema.campaigns.id, campaignId));

  return "anchored";
}

/** Whether this poll is the anchor kind, before anything is written. */
export async function isFormingPoll(
  env: Env,
  campaignId: string | null,
): Promise<boolean> {
  if (!campaignId) return false;
  const campaign = await db(env)
    .select({ state: schema.campaigns.state })
    .from(schema.campaigns)
    .where(eq(schema.campaigns.id, campaignId))
    .get();
  return campaign?.state === "FORMING";
}
