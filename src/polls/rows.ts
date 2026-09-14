import { asc, eq, inArray } from "drizzle-orm";
import type { Env } from "../env.ts";
import { db, schema } from "../db/index.ts";
import { rosterOf } from "../campaigns/roster.ts";
import type { PollDateRow, PollView } from "./render.ts";

/**
 * A poll, its dates and their tallies, read out of D1 in the shape the renderer
 * takes. The renderer is pure and this is where the impurity lives, which is the
 * same split `src/attendance/{render,rows}.ts` uses.
 */
export async function pollView(
  env: Env,
  pollId: string,
  asOf: Date,
  forUserId?: string,
): Promise<PollView | undefined> {
  const poll = await db(env)
    .select()
    .from(schema.datePolls)
    .where(eq(schema.datePolls.id, pollId))
    .get();
  if (!poll) return undefined;

  const dates = await db(env)
    .select()
    .from(schema.pollDates)
    .where(eq(schema.pollDates.pollId, pollId))
    .orderBy(asc(schema.pollDates.startsAt), asc(schema.pollDates.id))
    .all();

  // One query for every answer to every date of this poll, rather than one per
  // date. A poll has at most ten dates and a roster has a handful of people, so
  // this is a few dozen rows.
  const answers = dates.length
    ? await db(env)
        .select({
          pollDateId: schema.pollResponses.pollDateId,
          userId: schema.pollResponses.userId,
        })
        .from(schema.pollResponses)
        .where(
          inArray(
            schema.pollResponses.pollDateId,
            dates.map((date) => date.id),
          ),
        )
        .all()
    : [];

  const rows: PollDateRow[] = dates.map((date) => ({
    id: date.id,
    startsAt: date.startsAt,
    endsAt: date.endsAt,
    yes: answers.filter((answer) => answer.pollDateId === date.id).length,
    outcome: date.outcome,
  }));

  return {
    poll: {
      id: poll.id,
      title: await titleOf(env, poll),
      status: poll.status,
      closesAt: poll.closesAt,
    },
    dates: rows,
    rosterSize: poll.campaignId ? (await rosterOf(env, poll.campaignId)).length : null,
    ...(forUserId
      ? {
          chosen: answers
            .filter((answer) => answer.userId === forUserId)
            .map((answer) => answer.pollDateId),
        }
      : {}),
    asOf,
  };
}

/**
 * What the post calls itself. A poll about a session names the campaign; a poll
 * looking for a day names the game, if one was chosen. Either way it is somebody
 * else's text and the renderer escapes it.
 */
async function titleOf(
  env: Env,
  poll: typeof schema.datePolls.$inferSelect,
): Promise<string | null> {
  if (poll.campaignId) {
    const campaign = await db(env)
      .select({ name: schema.campaigns.name })
      .from(schema.campaigns)
      .where(eq(schema.campaigns.id, poll.campaignId))
      .get();
    if (campaign) return campaign.name;
  }
  if (poll.gameId) {
    const game = await db(env)
      .select({ name: schema.games.name })
      .from(schema.games)
      .where(eq(schema.games.id, poll.gameId))
      .get();
    if (game) return game.name;
  }
  return null;
}

/** Who answered what, for the win rule. */
export async function tallies(env: Env, pollId: string): Promise<Map<string, number>> {
  const view = await pollView(env, pollId, new Date());
  return new Map((view?.dates ?? []).map((date) => [date.id, date.yes]));
}
