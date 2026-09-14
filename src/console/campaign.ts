import { and, asc, count, eq, gte } from "drizzle-orm";
import type { Env } from "../env.ts";
import { db, schema } from "../db/index.ts";
import {
  SETTING_DEFAULTS,
  SETTING_KEYS,
  getSetting,
  settingOr,
} from "../db/settings.ts";
import {
  remainingSessions,
  rosterOf,
  type RosterMember,
} from "../campaigns/roster.ts";
import type { CampaignState } from "../campaigns/lifecycle.ts";
import { agendaBetween, windowAround, type AgendaRow } from "./agenda.ts";
import { syncStateOf, type SyncState } from "./session-detail.ts";

/**
 * One campaign, as the console shows it: the *plan*.
 *
 * Phase 2 (#25) already ships the campaign form and the lifecycle actions. This
 * is the page built around them — where the campaign is in its life and where it
 * may go next, the cadence it runs on, who is on it, and what is coming.
 *
 * What it deliberately does not hold is the campaign's **record**: the sessions
 * it has already played and the flake memory counted from them (`p6/6`), and its
 * open polls (`p6/7`). That is not a size argument. The plan and the record fail
 * differently — a plan is wrong when the cadence or the roster is wrong, a
 * record is wrong when a denominator counts sessions somebody could not have
 * been at — and a page holding both at once is a page where neither failure is
 * legible.
 *
 * Nothing here calls Discord or Google. The channel link is a URL assembled from
 * ids and the sync chip is `syncStateOf` reading the `calendar_links` row that
 * the projector wrote, exactly as the session rail does it. Orrey's database is
 * the source of truth; a console that asked Google would be showing a projection
 * as though it were the thing projected.
 */
const HORIZON_DAYS = 365;

/**
 * A cadence is two columns and it only means anything with both.
 *
 * `stated` is not `anchor !== null && intervalWeeks !== null` restated for
 * convenience — it is the page's answer to "why is nothing being materialised",
 * and the materialiser's own precondition. A campaign missing either half
 * produces no sessions at all and says so in words rather than showing an empty
 * table and letting the organiser guess.
 */
export interface Cadence {
  anchor: number | null;
  intervalWeeks: number | null;
  stated: boolean;
}

/** An agenda row with the chip the session rail introduced. */
export interface UpcomingSession extends AgendaRow {
  sync: { state: SyncState; syncedAt: number | null; lastError: string | null };
}

export interface CampaignPage {
  id: string;
  name: string;
  kind: "run" | "play" | "tracked";
  state: CampaignState;
  /**
   * Where it may go from here, read off the one edge map rather than restated.
   * Empty for CONCLUDED, which is terminal — so the page renders no actions for
   * one without needing to know why.
   */
  nextStates: CampaignState[];
  gameId: string | null;
  gameName: string | null;
  quorum: number | null;
  capacity: number | null;
  maxSessions: number | null;
  firstSessionNumber: number;
  /** Null for an open-ended campaign: no maximum means no remainder. */
  remaining: number | null;
  cadence: Cadence;
  /** Assembled from ids. Never a reason to call Discord. */
  channelUrl: string | null;
  roleId: string | null;
  roster: RosterMember[];
  upcoming: UpcomingSession[];
  /**
   * Why `upcoming` is empty, in words, or null when it is not empty.
   *
   * An empty table is not an answer. "No cadence set" and "it has concluded" and
   * "the clock has not reached this one yet" are three different situations with
   * three different things to do about them, and a page that renders the same
   * blank rectangle for all three is a page that sends the organiser to the
   * database.
   */
  upcomingNote: string | null;
}

export async function campaignPage(
  env: Env,
  campaignId: string,
  asOf: Date,
): Promise<CampaignPage | undefined> {
  const row = await db(env)
    .select({ campaign: schema.campaigns, gameName: schema.games.name })
    .from(schema.campaigns)
    .leftJoin(schema.games, eq(schema.campaigns.gameId, schema.games.id))
    .where(eq(schema.campaigns.id, campaignId))
    .get();
  if (!row) return undefined;

  const { campaign } = row;
  const guildId = await getSetting<string>(env, SETTING_KEYS.guildId);
  const timeZone = await settingOr<string>(
    env,
    SETTING_KEYS.timezone,
    SETTING_DEFAULTS[SETTING_KEYS.timezone],
  );

  const cadence: Cadence = {
    anchor: campaign.recurrenceAnchor,
    intervalWeeks: campaign.intervalWeeks,
    stated:
      campaign.recurrenceAnchor !== null &&
      campaign.intervalWeeks !== null &&
      campaign.intervalWeeks > 0,
  };

  const materialised = await sessionCount(env, campaignId);
  const remaining = remainingSessions(campaign, materialised);
  const upcoming = await upcomingFor(env, campaignId, asOf, timeZone);

  return {
    id: campaign.id,
    name: campaign.name,
    kind: campaign.kind,
    state: campaign.state,
    nextStates: nextStatesOf(campaign.state),
    gameId: campaign.gameId,
    gameName: row.gameName,
    quorum: campaign.quorum,
    capacity: campaign.capacity,
    maxSessions: campaign.maxSessions,
    firstSessionNumber: campaign.firstSessionNumber,
    remaining,
    cadence,
    channelUrl:
      guildId && campaign.discordChannelId
        ? `https://discord.com/channels/${guildId}/${campaign.discordChannelId}`
        : null,
    roleId: campaign.discordRoleId,
    // `rosterOf` and not a second query: a FORMING campaign's roster is its
    // claimants and a started one's is its members, and that rule lives in one
    // place. A page that re-cut it would be the console disagreeing with the
    // attendance post about who is on a campaign.
    roster: await rosterOf(env, campaignId),
    upcoming,
    upcomingNote: noteFor(campaign.state, cadence, remaining, upcoming.length),
  };
}

/**
 * The horizon, filtered to this campaign.
 *
 * It goes through `agendaBetween` rather than querying `sessions` directly so
 * that a row here and the same row on the agenda carry the same tally, the same
 * roster size and the same quorum shape. Two pages showing one session must
 * never disagree about whether it has quorum, and the only way to be sure of
 * that is for there to be one query.
 */
async function upcomingFor(
  env: Env,
  campaignId: string,
  asOf: Date,
  timeZone: string,
): Promise<UpcomingSession[]> {
  // The window opens at the caller's `asOf`, not at the clock's. Everything in
  // this file takes the instant as an argument so a test — and the ICS feed in
  // `p6/15` — can ask what the page said on a Tuesday in November without
  // moving the machine's clock underneath it.
  const { from, to } = windowAround(asOf, HORIZON_DAYS);
  const { rows } = await agendaBetween(env, from, to, asOf, timeZone);

  const mine = rows.filter((row) => row.campaignId === campaignId);
  if (mine.length === 0) return [];

  const links = await db(env)
    .select()
    .from(schema.calendarLinks)
    .all()
    .then((all) => new Map(all.map((link) => [link.sessionId, link])));

  return mine.map((row) => ({
    ...row,
    sync: syncStateOf(links.get(row.sessionId)),
  }));
}

/** How many sessions this campaign has, ever — the denominator `remaining` counts down from. */
async function sessionCount(env: Env, campaignId: string): Promise<number> {
  const row = await db(env)
    .select({ n: count() })
    .from(schema.sessions)
    .where(eq(schema.sessions.campaignId, campaignId))
    .get();
  return row?.n ?? 0;
}

/**
 * The edges, from `src/campaigns/lifecycle.ts`.
 *
 * Restated here rather than imported because the map there is private and the
 * page needs the *labels* it offers, not the ability to move anything. The test
 * that matters is that a CONCLUDED campaign offers nothing: the page must not be
 * the thing that discovers CONCLUDED is terminal.
 */
function nextStatesOf(state: CampaignState): CampaignState[] {
  switch (state) {
    case "FORMING":
      return ["RUNNING"];
    case "RUNNING":
      return ["HIATUS", "CONCLUDED"];
    case "HIATUS":
      return ["RUNNING", "CONCLUDED"];
    case "CONCLUDED":
      return [];
  }
}

function noteFor(
  state: CampaignState,
  cadence: Cadence,
  remaining: number | null,
  upcoming: number,
): string | null {
  if (upcoming > 0) return null;
  if (state === "CONCLUDED") {
    return "This campaign has concluded. Nothing further is materialised, and nothing will be.";
  }
  if (state === "FORMING") {
    return "Nothing is materialised until the campaign starts. Start it to close the roster and fill the horizon.";
  }
  if (state === "HIATUS") {
    return "On hiatus, so nothing is being materialised. Bring it back to running to fill the horizon again.";
  }
  if (!cadence.stated) {
    return "No cadence set, so nothing is materialised. An anchor and an interval in weeks are what the horizon counts from.";
  }
  if (remaining === 0) {
    return "This campaign has materialised every session it was going to. Raise the maximum, or conclude it.";
  }
  return "Nothing inside the horizon yet. The clock fills this in — it does not need asking.";
}
