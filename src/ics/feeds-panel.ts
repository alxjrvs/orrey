import { asc, eq, sql } from "drizzle-orm";
import type { Env } from "../env.ts";
import { db, schema } from "../db/index.ts";

/**
 * The holder's own feed URLs, and the rotate.
 *
 * The token is a **credential**. It is never logged, never written into
 * `audit_log`, and never placed in a URL the console hands to a third party. The
 * audit row records that a token was rotated and says nothing about what it
 * became — a log entry carrying the new token would be a credential store with a
 * retention policy nobody wrote.
 *
 * The id comes off the session cookie and never off the query string, for the
 * same reason `p6/13`'s delete does: a panel that takes an id is a panel that
 * shows somebody else's feed URLs.
 */
export interface FeedLink {
  label: string;
  url: string;
}

export interface FeedsPanel {
  links: FeedLink[];
  /**
   * The lag, on the panel rather than in a tooltip.
   *
   * Google refreshes a public ICS feed every eight to twenty-four hours, so a
   * change made now reaches a subscribed Google Calendar tomorrow. Somebody who
   * does not know that reads a correct feed as a broken one.
   */
  lag: string;
}

export const LAG =
  "Google refreshes a subscribed ICS feed every eight to twenty-four hours, so a change made now usually shows up tomorrow. The Orrey calendar is the timely one; these feeds are for choosing what you see, not for seeing it sooner.";

export async function feedsPanel(
  env: Env,
  userId: string,
  origin: string,
): Promise<FeedsPanel | undefined> {
  const holder = await db(env)
    .select({ feedToken: schema.users.feedToken })
    .from(schema.users)
    .where(eq(schema.users.discordId, userId))
    .get();
  if (!holder) return undefined;

  const campaigns = await db(env)
    .select({ id: schema.campaigns.id, name: schema.campaigns.name })
    .from(schema.campaignMembers)
    .innerJoin(schema.campaigns, eq(schema.campaignMembers.campaignId, schema.campaigns.id))
    .where(eq(schema.campaignMembers.userId, userId))
    .orderBy(asc(schema.campaigns.name))
    .all();

  // Built from the request's own origin. A hardcoded host is a URL that is wrong
  // on every environment but one, and the person copying it has no way to tell.
  const base = `${origin}/ics/${encodeURIComponent(holder.feedToken)}`;

  return {
    links: [
      { label: "Everything", url: `${base}/all.ics` },
      ...campaigns.map((campaign) => ({
        label: campaign.name,
        url: `${base}/campaign/${encodeURIComponent(campaign.id)}.ics`,
      })),
    ],
    lag: LAG,
  };
}

/**
 * A new token for this person, and nobody else's.
 *
 * The old URL stops resolving the moment this returns — `p6/15`'s lookup is a
 * single `where feed_token = ?` — so every subscribed client has to be
 * re-pointed by hand. That is stated on the panel before the click, because it
 * is not a thing anybody can be told afterwards.
 */
export async function rotateFeedToken(env: Env, userId: string): Promise<string | undefined> {
  const token = crypto.randomUUID().replace(/-/g, "");

  const d = db(env);
  const [updated] = await d.batch([
    d
      .update(schema.users)
      .set({ feedToken: token, updatedAt: sql`(unixepoch())` })
      .where(eq(schema.users.discordId, userId))
      .returning({ discordId: schema.users.discordId }),
    d.insert(schema.auditLog).values({
      id: crypto.randomUUID(),
      actorUserId: userId,
      action: "feed.rotate",
      targetType: "user",
      targetId: userId,
      // No `before` and no `after`. Both would be credentials, and an audit log
      // holding one is a credential store with a retention policy nobody wrote.
      detail: { rotated: true },
    }),
  ]);

  return updated.length > 0 ? token : undefined;
}
