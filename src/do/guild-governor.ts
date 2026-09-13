import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env.ts";
import { asDiscordFailure } from "../discord/rest.ts";

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
      try {
        return await work();
      } catch (error) {
        // A 429 is the guild's problem, not this call's, and the hold has to be
        // in place before the next queued call reads the clock — so it is taken
        // here, inside the chain, rather than by the caller a round trip later.
        const retryAfterMs = asDiscordFailure(error)?.retryAfterMs;
        if (retryAfterMs !== undefined) this.notBefore = Math.max(this.notBefore, Date.now() + retryAfterMs);
        throw error;
      }
    });
    this.queue = next.catch(() => undefined);
    return next as Promise<T>;
  }

  async holdUntil(timestampMs: number): Promise<void> {
    this.notBefore = Math.max(this.notBefore, timestampMs);
  }

  /** What the guild is currently held until, as unix ms. 0 when it is free. */
  async heldUntil(): Promise<number> {
    return this.notBefore;
  }
}
