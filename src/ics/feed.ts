import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { Env } from "../env.ts";
import { db, schema } from "../db/index.ts";
import { loadProjectionTarget } from "../projection/target.ts";
import { feedZone, icsEventFor } from "./event.ts";
import { serialise, type IcsEvent } from "./serialise.ts";

/**
 * What one person's feed contains.
 *
 * The token is the only credential these feeds accept — a calendar client cannot
 * log in, which is the whole reason `users.feed_token` has existed since phase 0.
 * Nothing on this path reads a cookie, and nothing on it writes.
 *
 * **An unknown token and an unauthorised campaign are the same answer.** Both
 * come back `undefined` here and both become an empty 404 above. Distinguishing
 * them would confirm which tokens are real to somebody trying them, which is the
 * one thing a credential in a URL must not do.
 */
export interface Feed {
  name: string;
  events: IcsEvent[];
}

export async function feedFor(
  env: Env,
  feedToken: string,
  campaignId?: string,
): Promise<Feed | undefined> {
  const holder = await db(env)
    .select({ discordId: schema.users.discordId })
    .from(schema.users)
    .where(eq(schema.users.feedToken, feedToken))
    .get();
  if (!holder) return undefined;

  const campaigns = await db(env)
    .select({ id: schema.campaignMembers.campaignId })
    .from(schema.campaignMembers)
    .where(eq(schema.campaignMembers.userId, holder.discordId))
    .all()
    .then((rows) => rows.map((row) => row.id));

  if (campaignId !== undefined && !campaigns.includes(campaignId)) return undefined;

  const mine = campaignId === undefined ? campaigns : [campaignId];

  const sessionIds = [
    ...(mine.length > 0
      ? await db(env)
          .select({ id: schema.sessions.id })
          .from(schema.sessions)
          .where(inArray(schema.sessions.campaignId, mine))
          .orderBy(asc(schema.sessions.startsAt))
          .all()
          .then((rows) => rows.map((row) => row.id))
      : []),
    // Game days are the holder's own signups, and only on the whole-server feed:
    // a day is nobody's campaign, so narrowing to one campaign excludes it by
    // construction rather than by a filter somebody has to remember.
    ...(campaignId === undefined ? await signedUpDays(env, holder.discordId) : []),
  ];

  const events: IcsEvent[] = [];
  for (const id of sessionIds) {
    const target = await loadProjectionTarget(env, id);
    if (target) events.push(await icsEventFor(target));
  }

  return {
    name: campaignId === undefined ? "Orrey" : `Orrey — ${campaignId}`,
    events,
  };
}

/** The sessions of the game days this person holds a live claim on. */
async function signedUpDays(env: Env, userId: string): Promise<string[]> {
  const days = await db(env)
    .select({ targetId: schema.signups.targetId })
    .from(schema.signups)
    .where(
      and(
        eq(schema.signups.targetType, "game_day"),
        eq(schema.signups.userId, userId),
        // Withdrawn is not "coming". A day somebody left should leave their
        // calendar, and it does because the event is simply not emitted.
        sql`${schema.signups.state} <> 'out'`,
      ),
    )
    .all()
    .then((rows) => rows.map((row) => row.targetId));

  if (days.length === 0) return [];

  return db(env)
    .select({ id: schema.sessions.id })
    .from(schema.sessions)
    .where(inArray(schema.sessions.gameDayId, days))
    .orderBy(asc(schema.sessions.startsAt))
    .all()
    .then((rows) => rows.map((row) => row.id));
}

/**
 * The whole response, text and headers.
 *
 * `private` on the cache header, not `public`: the token is in the path, so a
 * shared cache holding this response is a shared cache holding the credential.
 */
export async function icsResponse(
  env: Env,
  feed: Feed,
  stampedAt: number,
): Promise<{ body: string; headers: Record<string, string> }> {
  const timeZone = await feedZone(env);
  return {
    body: serialise({ name: feed.name, timeZone, events: feed.events, stampedAt }),
    headers: {
      "content-type": "text/calendar; charset=utf-8",
      "cache-control": "private, max-age=900",
    },
  };
}
