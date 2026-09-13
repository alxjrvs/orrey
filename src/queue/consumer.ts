import type { Env, OutboxMessage } from "../env.ts";

/**
 * Outbound projection. Google Calendar and Discord *scheduled events* only —
 * both of which Orrey reconciles against a stored fingerprint. Messages never
 * appear here: they are sent once and forgotten.
 */
export async function handleQueueBatch(
  batch: MessageBatch<OutboxMessage>,
  _env: Env,
  _ctx: ExecutionContext,
): Promise<void> {
  for (const message of batch.messages) {
    try {
      switch (message.body.kind) {
        case "gcal.upsert":
        case "gcal.delete":
        case "discord.event.upsert":
        case "discord.event.delete":
          // Phase 1.
          message.ack();
          break;
      }
    } catch (error) {
      console.error("projection failed", message.body, error);
      message.retry();
    }
  }
}
