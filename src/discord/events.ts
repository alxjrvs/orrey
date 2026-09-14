import { eq, sql } from "drizzle-orm";
import type { Env, OutboxMessage } from "../env.ts";
import { db, schema } from "../db/index.ts";
import { requireGuildId } from "../db/settings.ts";
import { discordFingerprint, sessionTitle, type ProjectionTarget } from "../projection/target.ts";
import {
  find,
  record,
  retract,
  standing,
  type PublicationRef,
} from "../projection/publications.ts";
import { throughGovernor } from "./governor.ts";
import {
  createScheduledEvent,
  deleteScheduledEvent,
  isLapsedEvent,
  isUnknownEvent,
  listScheduledEvents,
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

/**
 * Orrey's mark on a scheduled event, carried in the description.
 *
 * Google needs no equivalent: its event id is derived from the session id, so an
 * insert that lands twice lands on the same event. Discord hands out its own
 * ids, so the only way to recognise an event Orrey already made — after a crash
 * between the POST and the write that was going to remember it — is to have
 * written something into the event that says whose it is.
 *
 * It is constant per session, so it moves the content fingerprint exactly once:
 * on the first upsert after this lands, and never again.
 *
 * The closing bracket is not decoration. Session ids are `<campaign>-s<number>`,
 * so an unterminated marker makes `…-s1` a prefix of `…-s12`, and a substring
 * test would let session 1 adopt session 12's live event: rewrite it with the
 * wrong name and times, record both sessions against one remote id, and then
 * delete session 12's event when session 1 is retracted. The delimiter is what
 * makes the match exact.
 */
export function markerFor(sessionId: string): string {
  return `[orrey:session:${sessionId}]`;
}

export function isMarkedFor(event: { description?: string | null }, sessionId: string): boolean {
  return (event.description ?? "").includes(markerFor(sessionId));
}

export function scheduledEventBody(target: ProjectionTarget): Record<string, unknown> {
  const { session, campaign } = target;
  const base = {
    name: sessionTitle(target),
    privacy_level: GUILD_ONLY,
    scheduled_start_time: isoOf(session.startsAt),
    scheduled_end_time: isoOf(session.endsAt),
    description: markerFor(session.id),
  };

  // A VOICE event lives in a channel and needs no location; an EXTERNAL one is
  // the opposite, and Discord rejects it without both an end time and a place.
  if (campaign?.locationType === "voice" && campaign.discordVoiceChannelId) {
    // entity_metadata: null for the same reason the other branch sends
    // channel_id: null — converting an existing event between the two types is
    // a PATCH, and Discord rejects one that still carries the old type's field.
    return {
      ...base,
      entity_type: EntityType.VOICE,
      channel_id: campaign.discordVoiceChannelId,
      entity_metadata: null,
    };
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

/** This session's entry in the ledger of what Orrey has put into the world. */
function refFor(sessionId: string): PublicationRef {
  return { surface: "discord", kind: "event", targetId: sessionId };
}

async function upsert(env: Env, target: ProjectionTarget, guildId: string): Promise<void> {
  const { session } = target;
  const fingerprint = await discordFingerprint(target);

  // The redelivery case, and the "nothing actually changed" case: a write that
  // would set what is already set is a rate-limit slot spent for nothing. The
  // record of it is not skippable, though — see the same guard in the Google
  // projector for why.
  if (session.discordEventId && session.discordEventFingerprint === fingerprint) {
    await ensureRecorded(env, session.id, session.discordEventId);
    return;
  }

  const body = scheduledEventBody(target);
  const ref = refFor(session.id);

  // The id the session remembers, or the one the ledger does. The ledger is
  // written before `sessions` is, so it is ahead by exactly the window that used
  // to orphan an event: POST returns, the id write fails, the retry finds a null
  // `discord_event_id` and creates a second one.
  const ledger = await find(env, ref);
  const remembered =
    session.discordEventId ?? (ledger?.state === "published" ? ledger.remoteId : null);

  const event = await throughGovernor(env, guildId, async () => {
    // And if even the ledger write was lost, ask Discord. An event Orrey made
    // carries this session's marker, so the guild's own list is the last record
    // standing — bounded by the 100-per-guild cap, which is what makes looking
    // before creating affordable.
    const known = remembered ?? (await adoptable(env, guildId, session.id));

    if (!known) return createScheduledEvent(env, guildId, body);
    try {
      return await modifyScheduledEvent(env, guildId, known, body);
    } catch (error) {
      // The session still wants an event, so make one rather than retrying
      // into the DLQ.
      // Someone deleted it, or it lapsed out from under us, or its old start
      // time has passed and Discord has already marked it COMPLETED — which
      // cannot be moved, only replaced.
      if (isUnknownEvent(error) || isLapsedEvent(error)) {
        return createScheduledEvent(env, guildId, body);
      }
      throw error;
    }
  });

  // The ledger first, then the session column. `sessions.discord_event_id`
  // cascades away with the row; this does not, and after a delete it is the only
  // thing that can still say what is up in Discord and needs taking down.
  await record(env, refFor(session.id), event.id);

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

  // The session column is no longer the only thing that knows. It is null in
  // exactly the case this has to handle — the id write was the thing that
  // failed — so returning on it alone left the event up and called it done.
  const ledger = await find(env, refFor(session.id));
  const eventId =
    session.discordEventId ?? (ledger?.state === "published" ? ledger.remoteId : null);
  if (!eventId) return;

  try {
    await throughGovernor(env, guildId, () => deleteScheduledEvent(env, guildId, eventId));
  } catch (error) {
    // Already gone is the outcome asked for.
    if (!isUnknownEvent(error)) throw error;
  }

  // Retracted, not forgotten: the row and its `remote_id` stay, so phase 7's
  // reconcile can account for an event it finds rather than being puzzled by it.
  await retract(env, refFor(session.id));

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

/** An event already in the guild carrying this session's marker, if there is one. */
async function adoptable(env: Env, guildId: string, sessionId: string): Promise<string | null> {
  const events = await listScheduledEvents(env, guildId);
  return events.find((event) => isMarkedFor(event, sessionId))?.id ?? null;
}

/**
 * Take down what Orrey put up, for a session whose row is already gone.
 *
 * `project` used to return on a missing session and ack the message. But delete
 * is precisely the case where the row is disappearing, so that was the common
 * path rather than the rare one — the retraction quietly did nothing and the
 * event stayed up with nobody holding its id. The ledger does not cascade, so it
 * still knows what to take down.
 */
export async function unprojectOrphanedEvent(env: Env, sessionId: string): Promise<void> {
  const guildId = await requireGuildId(env);

  for (const row of await standing(env, sessionId)) {
    // Messages are not retracted. They are send-only, and a message Orrey can no
    // longer explain is a message a person reads and ignores — not a duplicate
    // that books people into something.
    if (row.surface !== "discord" || row.kind !== "event" || !row.remoteId) continue;

    const remoteId = row.remoteId;
    try {
      await throughGovernor(env, guildId, () => deleteScheduledEvent(env, guildId, remoteId));
    } catch (error) {
      if (!isUnknownEvent(error)) throw error;
    }
    await retract(env, { surface: "discord", kind: "event", targetId: sessionId });
  }
}

/** The ledger learns about an event published before there was a ledger. */
async function ensureRecorded(env: Env, sessionId: string, eventId: string): Promise<void> {
  const ref = refFor(sessionId);
  const known = await find(env, ref);
  if (known?.state === "published" && known.remoteId === eventId) return;
  // A retraction is a decision, not a gap. Do not undo one by backfilling.
  if (known?.state === "retracted") return;
  await record(env, ref, eventId);
}
