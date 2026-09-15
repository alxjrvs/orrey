import type { Env } from "../env.ts";
import { drainJobs } from "../jobs/drain.ts";
import { materialiseHorizon } from "../campaigns/materialise.ts";
import { renewWatchIfDue } from "../google/watch.ts";
import { reconcile } from "../google/sync.ts";

/**
 * The clock. One cron expression, every minute, and the four logical schedules
 * derived from the time it fired — because Workers Free caps an *account* at
 * five cron triggers and this account has other Workers holding most of them.
 * Dispatching by time costs nothing: the minute tick runs anyway.
 */
export type Tick = "drain" | "horizon" | "watch-renew" | "reconcile";

/** Which schedules fire for a minute, in the order they should run. UTC. */
export function ticksDueAt(when: Date): Tick[] {
  const minute = when.getUTCMinutes();
  const hour = when.getUTCHours();
  const ticks: Tick[] = ["drain"];
  if (minute === 0) ticks.push("horizon");
  if (hour === 4 && minute === 0) ticks.push("watch-renew");
  if (hour === 5 && minute === 30) ticks.push("reconcile");
  return ticks;
}

export async function handleScheduled(event: ScheduledController, env: Env): Promise<void> {
  for (const tick of ticksDueAt(new Date(event.scheduledTime))) {
    switch (tick) {
      case "drain":
        await drainJobs(env);
        break;

      case "horizon":
        // Every RUNNING campaign with a cadence, out to the horizon. It inserts
        // and never updates, and the ids are derived, so running it twice in an
        // hour is free and running it after an outage catches up by itself.
        await materialiseHorizon(env, new Date(event.scheduledTime));
        break;

      case "watch-renew":
        // Google `events.watch` channels have a ~7-day TTL and do not auto-renew,
        // so this opens one when there is none and replaces one before it
        // lapses. Daily against a weekly TTL and a two-day window, so a tick
        // that fails has two more before anything is missed.
        await renewWatchIfDue(env, Math.floor(event.scheduledTime / 1000));
        break;

      case "reconcile":
        // Full reconcile: the whole calendar through the same classifier the
        // pushes use, with no `syncToken`. `events.watch` is not completely
        // reliable, and a nightly pass is what makes an unreliable channel
        // merely slow. Never messages — a change it finds goes through the same
        // handlers, and those decide what is worth saying.
        await reconcile(env);
        break;
    }
  }
}
