import { DurableObject } from "cloudflare:workers";
import { eq, sql } from "drizzle-orm";
import type { Env } from "../env.ts";
import { db, schema } from "../db/index.ts";
import { rememberUser } from "../db/users.ts";
import type { InteractionUser } from "../discord/types.ts";

/**
 * One per session. Six people clicking "In" at once must not each read the same
 * tally and each render a different one: the click that crosses quorum has to
 * be the click that renders the confirmed state.
 *
 * The Durable Object's input gate alone is not enough here — it reopens across
 * non-storage I/O, and every read and write in these methods is a D1 call. So
 * the work is chained explicitly, and each method returns the state it just
 * wrote, which is what the interaction response renders.
 */
export class SessionLock extends DurableObject<Env> {
  private chain: Promise<unknown> = Promise.resolve();

  private serialise<T>(work: () => Promise<T>): Promise<T> {
    const next = this.chain.then(work);
    this.chain = next.catch(() => undefined);
    return next as Promise<T>;
  }

  /**
   * The phase-0 exit criterion: a click that reaches D1 and comes back with the
   * tally to render. Phase 3 replaces this with intent, quorum and jeopardy —
   * the shape, read-modify-write behind the lock, is the shape they will use.
   */
  async click(target: string, actor: InteractionUser): Promise<SmokeTally> {
    return this.serialise(async () => {
      await rememberUser(this.env, actor);

      const key = tallyKey(target);
      const current = (await tally(this.env, key)) ?? { clicks: 0 };
      const next: SmokeTally = {
        clicks: current.clicks + 1,
        lastBy: actor.global_name ?? actor.username,
        asOf: new Date().toISOString(),
      };

      await db(this.env)
        .insert(schema.settings)
        .values({ key, value: next })
        .onConflictDoUpdate({
          target: schema.settings.key,
          set: { value: next, updatedAt: sql`(unixepoch())` },
        });

      return next;
    });
  }
}

export interface SmokeTally {
  clicks: number;
  lastBy?: string;
  asOf?: string;
}

export function tallyKey(target: string): string {
  return `smoke:${target}`;
}

export async function tally(env: Env, key: string): Promise<SmokeTally | undefined> {
  const row = await db(env)
    .select()
    .from(schema.settings)
    .where(eq(schema.settings.key, key))
    .get();
  return row?.value as SmokeTally | undefined;
}
