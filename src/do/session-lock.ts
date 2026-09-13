import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env.ts";

/**
 * One per session. Six people clicking "In" at once must not each read the same
 * tally and each render a different one: the click that crosses quorum has to
 * be the click that renders the confirmed state.
 */
export class SessionLock extends DurableObject<Env> {
  private chain: Promise<unknown> = Promise.resolve();

  async withLock<T>(work: () => Promise<T>): Promise<T> {
    const next = this.chain.then(work);
    this.chain = next.catch(() => undefined);
    return next as Promise<T>;
  }
}
