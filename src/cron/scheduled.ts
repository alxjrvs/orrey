import type { Env } from "../env.ts";
import { drainJobs } from "../jobs/drain.ts";

/** The clock. Four schedules, dispatched by cron expression. */
export async function handleScheduled(event: ScheduledController, env: Env): Promise<void> {
  switch (event.cron) {
    case "* * * * *":
      await drainJobs(env);
      return;

    case "0 * * * *":
      // Materialise the horizon: at most two upcoming Discord events per campaign.
      return;

    case "0 4 * * *":
      // Google `events.watch` channels have a ~7-day TTL and do not auto-renew.
      return;

    case "30 5 * * *":
      // Full reconcile: fingerprints vs Google, event ids vs Discord. Never messages.
      return;

    default:
      console.warn("unhandled cron", event.cron);
  }
}
