import { eq, sql } from "drizzle-orm";
import type { Env, OutboxMessage } from "../env.ts";
import { db, schema } from "../db/index.ts";
import { requireGuildId } from "../db/settings.ts";
import { contentFingerprint, sessionTitle, type ProjectionTarget } from "../projection/target.ts";
import { throughGovernor } from "./governor.ts";
import {
  createScheduledEvent,
  deleteScheduledEvent,
  isUnknownEvent,
  modifyScheduledEvent,
} from "./rest.ts";

/**
 * Discord scheduled events are the only Discord objects Orrey reconciles. A
 * session names one, Orrey keeps it in step with the database, and the id it
 * gets back is stored — but never treated as permanent: Discord's COMPLETED and
 * CANCELED statuses are terminal and fire on their own, so an event can be gone
 * or frozen without anyone touching it. Phase 4 mints a replacement when a
 * lapsed session moves; here, a vanished event is simply made again.
 */
export const EntityType = { STAGE_INSTANCE: 1, VOICE: 2, EXTERNAL: 3 } as const;
const GUILD_ONLY = 2;

export function scheduledEventBody(target: ProjectionTarget): Record<string, unknown> {
  const { session, campaign } = target;
  const base = {
    name: sessionTitle(target),
    privacy_level: GUILD_ONLY,
    scheduled_start_time: isoOf(session.startsAt),
    scheduled_end_time: isoOf(session.endsAt),
  };

  // A VOICE event lives in a channel and needs no location; an EXTERNAL one is
  // the opposite, and Discord rejects it without both an end time and a place.
  if (campaign?.locationType === "voice" && campaign.discordVoiceChannelId) {
    return { ...base, entity_type: EntityType.VOICE, channel_id: campaign.discordVoiceChannelId };
  }
  return {
    ...base,
    entity_type: EntityType.EXTERNAL,
    channel_id: null,
    entity_metadata: { location: session.location ?? "To be confirmed" },
  };
}

export async function projectDiscordEvent(
  env: Env,
  target: ProjectionTarget,
  kind: "discord.event.upsert" | "discord.event.delete",
): Promise<void> {
  const guildId = await requireGuildId(env);
  return kind === "discord.event.delete"
    ? unproject(env, target, guildId)
    : upsert(env, target, guildId);
}

async function upsert(env: Env, target: ProjectionTarget, guildId: string): Promise<void> {
  const { session } = target;
  const fingerprint = await contentFingerprint(target);

  // The redelivery case, and the "nothing actually changed" case: a write that
  // would set what is already set is a rate-limit slot spent for nothing.
  if (session.discordEventId && session.discordEventFingerprint === fingerprint) return;

  const body = scheduledEventBody(target);
  const event = await throughGovernor(env, guildId, async () => {
    if (!session.discordEventId) return createScheduledEvent(env, guildId, body);
    try {
      return await modifyScheduledEvent(env, guildId, session.discordEventId, body);
    } catch (error) {
      // Someone deleted it, or it lapsed out from under us. The session still
      // wants an event, so make one rather than retrying into the DLQ.
      if (isUnknownEvent(error)) return createScheduledEvent(env, guildId, body);
      throw error;
    }
  });

  await db(env)
    .update(schema.sessions)
    .set({
      discordEventId: event.id,
      discordEventFingerprint: fingerprint,
      updatedAt: sql`(unixepoch())`,
    })
    .where(eq(schema.sessions.id, session.id));
}

async function unproject(env: Env, target: ProjectionTarget, guildId: string): Promise<void> {
  const { session } = target;
  if (!session.discordEventId) return;

  try {
    await throughGovernor(env, guildId, () =>
      deleteScheduledEvent(env, guildId, session.discordEventId as string),
    );
  } catch (error) {
    // Already gone is the outcome asked for.
    if (!isUnknownEvent(error)) throw error;
  }

  await db(env)
    .update(schema.sessions)
    .set({ discordEventId: null, discordEventFingerprint: null, updatedAt: sql`(unixepoch())` })
    .where(eq(schema.sessions.id, session.id));
}

export function isDiscordEventKind(kind: OutboxMessage["kind"]): boolean {
  return kind === "discord.event.upsert" || kind === "discord.event.delete";
}

function isoOf(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString();
}
