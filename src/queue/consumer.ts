import type { Env, OutboxMessage } from "../env.ts";
import {
  projectDiscordEvent,
  unprojectOrphanedEvent as unprojectOrphanedDiscordEvent,
} from "../discord/events.ts";
import {
  projectGoogleEvent,
  unprojectOrphanedEvent as unprojectOrphanedGoogleEvent,
} from "../google/calendar.ts";
import { isProjectable, loadProjectionTarget } from "../projection/target.ts";

/**
 * Outbound projection. Google Calendar and Discord *scheduled events* only —
 * both of which Orrey reconciles against a stored fingerprint. Messages never
 * appear here: they are sent once and forgotten.
 *
 * The spine is the same for every projector: load the session from D1 (the
 * message carries only an id), decide whether it should be projected at all,
 * hand it to the projector, and let a throw become a retry. After the
 * configured retries the message lands in the dead-letter queue, which is the
 * record of what could not be projected.
 */
export async function handleQueueBatch(
  batch: MessageBatch<OutboxMessage>,
  env: Env,
  _ctx: ExecutionContext,
): Promise<void> {
  for (const message of batch.messages) {
    try {
      await project(message.body, env);
      message.ack();
    } catch (error) {
      console.error("projection failed", message.body, error);
      message.retry();
    }
  }
}

/**
 * Exported so it can be tested without a queue, and called with the same
 * message shape a redelivery would carry: projecting twice must be indistinct
 * from projecting once.
 */
export async function project(body: OutboxMessage, env: Env): Promise<void> {
  const target = await loadProjectionTarget(env, body.sessionId);

  // `isProjectable` guards what Orrey *publishes*. A delete is the opposite —
  // it is how something published comes down — so gating it on the campaign
  // still running would strand a concluded campaign's events out there forever,
  // with an ack saying the work was done.
  const retracting = body.kind === "discord.event.delete" || body.kind === "gcal.delete";

  if (!target) {
    // The session row is gone. For an upsert that is the end of it: there is
    // nothing to project and nothing to retry, and retrying would only fill the
    // DLQ with work that can never succeed.
    //
    // For a *delete* it is the opposite. Deleting is precisely when the row
    // disappears, so a missing session is this path's common case, and returning
    // here used to ack a retraction that had quietly done nothing — leaving the
    // event up with nobody holding its id. The ledger does not cascade, so it
    // still knows what to take down.
    if (!retracting) return;
    return body.kind === "discord.event.delete"
      ? unprojectOrphanedDiscordEvent(env, body.sessionId)
      : unprojectOrphanedGoogleEvent(env, body.sessionId);
  }

  if (!retracting && !isProjectable(target)) return;

  switch (body.kind) {
    case "discord.event.upsert":
    case "discord.event.delete":
      return projectDiscordEvent(env, target, body.kind);

    case "gcal.upsert":
    case "gcal.delete":
      return projectGoogleEvent(env, target, body.kind);
  }
}
