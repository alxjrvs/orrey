import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env.ts";

/**
 * One per guild. Serialises outbound Discord writes so nothing piles up against
 * a per-route rate limit, and holds the retry-after clock between requests.
 */
export class GuildGovernor extends DurableObject<Env> {
  private queue: Promise<unknown> = Promise.resolve();
  private notBefore = 0;

  /** Runs `work` after any pending work for this guild, respecting retry-after. */
  async run<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(async () => {
      const wait = this.notBefore - Date.now();
      if (wait > 0) await scheduler.wait(wait);
      return work();
    });
    this.queue = next.catch(() => undefined);
    return next as Promise<T>;
  }

  async holdUntil(timestampMs: number): Promise<void> {
    this.notBefore = Math.max(this.notBefore, timestampMs);
  }
}
