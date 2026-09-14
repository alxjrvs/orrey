import { asc, count, eq } from "drizzle-orm";
import type { Env } from "../env.ts";
import { db, schema } from "../db/index.ts";
import { rosterOf } from "../campaigns/roster.ts";

/**
 * What the console reads. Every field comes from D1 — nothing here asks Discord
 * what it holds, because Orrey's database is the source of truth and a console
 * that read Discord back would be showing a projection as though it were the
 * thing projected.
 *
 * The ids are shown rather than resolved to names for the same reason: Orrey
 * adopts Discord objects it did not create, and a name it cached could be wrong
 * in a way that matters when somebody is pasting an id into a form.
 */
export interface CampaignSummary {
  id: string;
  name: string;
  kind: "run" | "play" | "tracked";
  state: "FORMING" | "RUNNING" | "HIATUS" | "CONCLUDED";
  gameId: string | null;
  gameName: string | null;
  discordChannelId: string | null;
  discordRoleId: string | null;
  locationType: "external" | "voice";
  recurrenceAnchor: number | null;
  intervalWeeks: number | null;
  quorum: number | null;
  capacity: number | null;
  maxSessions: number | null;
  firstSessionNumber: number;
  members: number;
  sessions: number;
}

export async function campaignSummaries(env: Env): Promise<CampaignSummary[]> {
  const rows = await db(env)
    .select({ campaign: schema.campaigns, gameName: schema.games.name })
    .from(schema.campaigns)
    .leftJoin(schema.games, eq(schema.campaigns.gameId, schema.games.id))
    .orderBy(asc(schema.campaigns.name))
    .all();

  // Two grouped counts rather than a count per campaign: four campaigns today,
  // but a per-row query is the kind of thing that is fine until it is not.
  const members = await memberCounts(env);
  const sessions = await sessionCounts(env);

  const summaries: CampaignSummary[] = rows.map(({ campaign, gameName }) => ({
    id: campaign.id,
    name: campaign.name,
    kind: campaign.kind,
    state: campaign.state,
    gameId: campaign.gameId,
    gameName,
    discordChannelId: campaign.discordChannelId,
    discordRoleId: campaign.discordRoleId,
    locationType: campaign.locationType,
    recurrenceAnchor: campaign.recurrenceAnchor,
    intervalWeeks: campaign.intervalWeeks,
    quorum: campaign.quorum,
    capacity: campaign.capacity,
    maxSessions: campaign.maxSessions,
    firstSessionNumber: campaign.firstSessionNumber,
    members: members.get(campaign.id) ?? 0,
    sessions: sessions.get(campaign.id) ?? 0,
  }));

  // A FORMING campaign has no members yet — its roster is the people who have
  // claimed a place. Counting `campaign_members` for one would show "Roster 0"
  // beside a campaign with claimants, which is the console disagreeing with the
  // attendance post about the same question. `rosterOf` is where that rule
  // lives, so ask it rather than restating it here.
  for (const summary of summaries) {
    if (summary.state === "FORMING") {
      summary.members = (await rosterOf(env, summary.id)).length;
    }
  }

  return summaries;
}

export interface GameSummary {
  id: string;
  name: string;
  minPlayers: number | null;
  maxPlayers: number | null;
  defaultDurationMinutes: number | null;
}

export function gameSummaries(env: Env): Promise<GameSummary[]> {
  return db(env)
    .select({
      id: schema.games.id,
      name: schema.games.name,
      minPlayers: schema.games.minPlayers,
      maxPlayers: schema.games.maxPlayers,
      defaultDurationMinutes: schema.games.defaultDurationMinutes,
    })
    .from(schema.games)
    .orderBy(asc(schema.games.name))
    .all();
}

/**
 * Two grouped counts rather than a count per campaign. Written out twice rather
 * than made generic: drizzle's table types do not generalise over "any table
 * with this column" without a cast, and a cast here would be hiding the one
 * thing worth reading — which column each count groups on.
 */
async function memberCounts(env: Env): Promise<Map<string, number>> {
  const rows = await db(env)
    .select({ key: schema.campaignMembers.campaignId, n: count() })
    .from(schema.campaignMembers)
    .groupBy(schema.campaignMembers.campaignId)
    .all();
  return new Map(rows.map((row) => [row.key, row.n]));
}

async function sessionCounts(env: Env): Promise<Map<string, number>> {
  const rows = await db(env)
    .select({ key: schema.sessions.campaignId, n: count() })
    .from(schema.sessions)
    .groupBy(schema.sessions.campaignId)
    .all();

  // A one-off has no campaign, so its group key is null and it belongs to none.
  return new Map(
    rows
      .filter((row): row is { key: string; n: number } => row.key !== null)
      .map((row) => [row.key, row.n]),
  );
}
