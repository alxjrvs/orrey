import { eq } from "drizzle-orm";
import type { Env } from "../env.ts";
import { db, schema } from "../db/index.ts";
import { fingerprint } from "./fingerprint.ts";

/**
 * What a projector needs to know: the session, and the campaign it belongs to.
 * Loaded from D1 every time a queue message is handled — never carried in the
 * message, which holds nothing but an id. The database is the source of truth,
 * so a message that has been sitting in the queue for a minute must not project
 * what was true when it was produced.
 */
export interface ProjectionTarget {
  session: typeof schema.sessions.$inferSelect;
  campaign: typeof schema.campaigns.$inferSelect | null;
}

export async function loadProjectionTarget(
  env: Env,
  sessionId: string,
): Promise<ProjectionTarget | undefined> {
  const row = await db(env)
    .select({ session: schema.sessions, campaign: schema.campaigns })
    .from(schema.sessions)
    .leftJoin(schema.campaigns, eq(schema.sessions.campaignId, schema.campaigns.id))
    .where(eq(schema.sessions.id, sessionId))
    .get();

  return row ? { session: row.session, campaign: row.campaign } : undefined;
}

/** `Age of Umbra — Session 12`, and what a one-off has instead. */
export function sessionTitle({ session, campaign }: ProjectionTarget): string {
  if (!campaign) return session.location ? `Session — ${session.location}` : "Session";
  return session.number == null ? campaign.name : `${campaign.name} — Session ${session.number}`;
}

/**
 * A fingerprint per surface, over exactly what that surface renders — because
 * the whole point of a fingerprint is to skip a write that would change
 * nothing. A shared one made moving the voice channel rewrite the *Google*
 * event, moving its `updated` for a field Google never showed, which is the
 * one thing phase 7's return path must not have to explain.
 */
export function discordProjectedContent(target: ProjectionTarget) {
  const { session, campaign } = target;
  return {
    ...googleProjectedContent(target),
    // Decides EXTERNAL vs VOICE, and which of the two fields the event carries.
    locationType: campaign?.locationType ?? "external",
    voiceChannelId: campaign?.discordVoiceChannelId ?? null,
  };
}

export function googleProjectedContent(target: ProjectionTarget) {
  const { session } = target;
  return {
    title: sessionTitle(target),
    startsAt: session.startsAt,
    endsAt: session.endsAt,
    location: session.location,
    state: session.state,
  };
}

export function discordFingerprint(target: ProjectionTarget): Promise<string> {
  return fingerprint(discordProjectedContent(target));
}

export function googleFingerprint(target: ProjectionTarget): Promise<string> {
  return fingerprint(googleProjectedContent(target));
}

/**
 * A campaign that is not running has nothing Orrey should be writing outward —
 * a concluded campaign's old sessions must not reappear on a calendar because a
 * queue message was redelivered. A session with no campaign (a one-off) is
 * always projectable.
 */
export function isProjectable({ campaign }: ProjectionTarget): boolean {
  return campaign === null || campaign.state === "RUNNING";
}
