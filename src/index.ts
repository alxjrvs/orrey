import { createApp } from "./http/app.ts";
import { handleQueueBatch } from "./queue/consumer.ts";
import { handleScheduled } from "./cron/scheduled.ts";
import type { Env, OutboxMessage } from "./env.ts";

export { GuildGovernor } from "./do/guild-governor.ts";
export { SessionLock } from "./do/session-lock.ts";
export { PollLock } from "./do/poll-lock.ts";

const app = createApp();

export default {
  fetch: app.fetch,

  async queue(batch: MessageBatch<OutboxMessage>, env: Env, ctx: ExecutionContext) {
    await handleQueueBatch(batch, env, ctx);
  },

  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(handleScheduled(event, env));
  },
} satisfies ExportedHandler<Env, OutboxMessage>;
