import type { Env, OutboxMessage } from "../env.ts";
import { projectDiscordEvent } from "../discord/events.ts";
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

  // The session is gone. There is nothing to project and nothing to retry —
  // retrying would only fill the DLQ with work that can never succeed.
  if (!target) return;

  if (!isProjectable(target)) return;

  switch (body.kind) {
    case "discord.event.upsert":
    case "discord.event.delete":
      return projectDiscordEvent(env, target, body.kind);

    case "gcal.upsert":
    case "gcal.delete":
      return notYet(body.kind, "the Google Calendar projector — #19");
  }
}

/**
 * A kind whose projector has not landed yet acks rather than throwing: a
 * poisoned queue is a worse failure mode than a projection that has not been
 * written, and the stack lands these two within the phase.
 */
function notYet(kind: OutboxMessage["kind"], what: string): void {
  console.log(`outbox: ${kind} is waiting on ${what}`);
}
