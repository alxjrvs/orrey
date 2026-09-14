import { DurableObject } from "cloudflare:workers";
import { and, eq, inArray } from "drizzle-orm";
import type { Env } from "../env.ts";
import { db, schema } from "../db/index.ts";
import { rememberUser } from "../db/users.ts";
import { pollView } from "../polls/rows.ts";
import type { PollView } from "../polls/render.ts";
import type { InteractionUser } from "../discord/types.ts";

/**
 * One per poll, not one per session.
 *
 * A poll can be about a session, but the thing being serialised is answers to
 * *this poll* — and an untargeted poll has no session to lock behind at all.
 * Keying on the session would also mean two people answering two different polls
 * about the same campaign queue behind each other for no reason.
 *
 * Like `SessionLock`, the input gate alone is not enough: it reopens across
 * non-storage I/O and every read and write here is a D1 call. So the work is
 * chained explicitly, and each method returns the state it just wrote, which is
 * what the interaction response renders.
 */
export class PollLock extends DurableObject<Env> {
  private chain: Promise<unknown> = Promise.resolve();

  private serialise<T>(work: () => Promise<T>): Promise<T> {
    const next = this.chain.then(work);
    this.chain = next.catch(() => undefined);
    return next as Promise<T>;
  }

  /**
   * What this person now says, and the whole post as it should read afterwards.
   *
   * **A replacement, not a toggle.** Discord sends the complete selection in
   * `data.values` every time, so the write is: delete this person's rows for
   * this poll, insert one per selected date. The delete happens even when
   * nothing comes back, because an empty selection is a real answer — "none of
   * these work" — and treating it as "said nothing" would silently keep the
   * answer they just withdrew.
   */
  async select({ pollId, actor, pollDateIds }: PollSelection): Promise<PollView | undefined> {
    return this.serialise(async () => {
      const poll = await db(this.env)
        .select()
        .from(schema.datePolls)
        .where(eq(schema.datePolls.id, pollId))
        .get();
      if (!poll) return undefined;

      // Identity is the Discord id; the names are a cache this refreshes.
      await rememberUser(this.env, actor);

      // Every date of this poll, so a stale select naming a date that has since
      // been removed cannot write a row against another poll's date.
      const dates = await db(this.env)
        .select({ id: schema.pollDates.id })
        .from(schema.pollDates)
        .where(eq(schema.pollDates.pollId, pollId))
        .all();
      const known = new Set(dates.map((date) => date.id));
      const chosen = [...new Set(pollDateIds)].filter((id) => known.has(id));

      const d = db(this.env);
      const clear = d
        .delete(schema.pollResponses)
        .where(
          and(
            eq(schema.pollResponses.userId, actor.id),
            inArray(
              schema.pollResponses.pollDateId,
              dates.length ? dates.map((date) => date.id) : [""],
            ),
          ),
        );
      const inserts = chosen.map((pollDateId) =>
        d.insert(schema.pollResponses).values({ pollDateId, userId: actor.id }),
      );

      // One batch: a clear that lands without its inserts reads as "none of
      // these work", which is a different answer from the one they gave. `clear`
      // leads so the tuple is non-empty however many dates were chosen.
      await d.batch([clear, ...inserts]);

      return pollView(this.env, pollId, new Date(), actor.id);
    });
  }

  /** The same read with no write behind it. */
  async read(pollId: string, userId: string): Promise<PollView | undefined> {
    return this.serialise(() => pollView(this.env, pollId, new Date(), userId));
  }
}

export interface PollSelection {
  pollId: string;
  actor: InteractionUser;
  /** The complete selection Discord sent. Empty is an answer. */
  pollDateIds: string[];
}
