import { and, asc, eq } from "drizzle-orm";
import type { Env } from "../env.ts";
import { db, schema } from "../db/index.ts";

/**
 * Who a campaign is for.
 *
 * It comes from two different places depending on where the campaign is in its
 * life, and that is #22's structural claim rather than a convenience: a campaign
 * entered straight into RUNNING — which is all four of the real ones — never had
 * signups and must not be asked for them. Started campaigns skip stages 1 and 2,
 * and this is what that means once something has to answer "who".
 *
 * A FORMING campaign has no members yet, so its roster is the people who have
 * claimed a place. The moment it starts, `transition` converts those into
 * members and this function stops looking at signups at all.
 */
export interface RosterMember {
  userId: string;
  /** The cache in `users`, never the identity. Falls back to a mention. */
  name: string;
  /** Null for a signup: nobody is GM of a campaign that has not started. */
  role: "gm" | "player" | null;
  characterName: string | null;
}

export async function rosterOf(env: Env, campaignId: string): Promise<RosterMember[]> {
  const campaign = await db(env)
    .select({ state: schema.campaigns.state })
    .from(schema.campaigns)
    .where(eq(schema.campaigns.id, campaignId))
    .get();

  if (!campaign) return [];
  return campaign.state === "FORMING" ? claimants(env, campaignId) : members(env, campaignId);
}

async function members(env: Env, campaignId: string): Promise<RosterMember[]> {
  const rows = await db(env)
    .select({
      userId: schema.campaignMembers.userId,
      role: schema.campaignMembers.role,
      characterName: schema.campaignMembers.characterName,
      username: schema.users.username,
      globalName: schema.users.globalName,
    })
    .from(schema.campaignMembers)
    .leftJoin(schema.users, eq(schema.campaignMembers.userId, schema.users.discordId))
    .where(eq(schema.campaignMembers.campaignId, campaignId))
    .orderBy(asc(schema.campaignMembers.joinedAt), asc(schema.campaignMembers.userId))
    .all();

  return rows.map((row) => ({
    userId: row.userId,
    name: displayName(row),
    role: row.role,
    characterName: row.characterName,
  }));
}

async function claimants(env: Env, campaignId: string): Promise<RosterMember[]> {
  const rows = await db(env)
    .select({
      userId: schema.signups.userId,
      characterName: schema.signups.characterName,
      username: schema.users.username,
      globalName: schema.users.globalName,
    })
    .from(schema.signups)
    .leftJoin(schema.users, eq(schema.signups.userId, schema.users.discordId))
    .where(
      and(
        eq(schema.signups.targetType, "campaign_forming"),
        eq(schema.signups.targetId, campaignId),
        // The waitlist is not the roster. It is the queue behind it.
        eq(schema.signups.state, "in"),
      ),
    )
    .orderBy(asc(schema.signups.createdAt), asc(schema.signups.userId))
    .all();

  return rows.map((row) => ({
    userId: row.userId,
    name: displayName(row),
    role: null,
    characterName: row.characterName,
  }));
}

function displayName(row: {
  userId: string;
  username: string | null;
  globalName: string | null;
}): string {
  return row.globalName ?? row.username ?? `<@${row.userId}>`;
}

/**
 * How many more sessions this campaign should produce, or null for "as many as
 * it keeps wanting".
 *
 * Reaching `max_sessions` stops materialisation. It does **not** conclude the
 * campaign: CONCLUDED is terminal, and nothing terminal should be entered by a
 * cron job on a Tuesday morning. The materialiser simply stops adding, the
 * console shows nothing remaining, and concluding stays the organiser's click.
 */
export function remainingSessions(
  campaign: { maxSessions: number | null },
  materialised: number,
): number | null {
  if (campaign.maxSessions === null) return null;
  return Math.max(0, campaign.maxSessions - materialised);
}

/** Whether the campaign has produced everything it was ever going to. */
export function isExhausted(
  campaign: { maxSessions: number | null },
  materialised: number,
): boolean {
  return remainingSessions(campaign, materialised) === 0;
}

/**
 * Whoever is running it. The first `gm` on the roster, or nobody — a campaign
 * can be entered without one, and a notice that invents a name is worse than one
 * that says "whoever is running it".
 *
 * It lives here, below both of phase 3's forks, because both of them want it:
 * the jeopardy notice names the GM, and the correction post is theirs alone.
 */
export async function gmOf(env: Env, campaignId: string): Promise<string | undefined> {
  const row = await db(env)
    .select({ userId: schema.campaignMembers.userId })
    .from(schema.campaignMembers)
    .where(
      and(
        eq(schema.campaignMembers.campaignId, campaignId),
        eq(schema.campaignMembers.role, "gm"),
      ),
    )
    .orderBy(asc(schema.campaignMembers.joinedAt))
    .get();

  return row?.userId;
}

/** Whether this person is the one who decides for this campaign. */
export async function isGm(env: Env, campaignId: string, userId: string): Promise<boolean> {
  return (await gmOf(env, campaignId)) === userId;
}
