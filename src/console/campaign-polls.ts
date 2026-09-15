import { and, asc, eq, inArray } from "drizzle-orm";
import type { Env } from "../env.ts";
import { db, schema } from "../db/index.ts";
import { SETTING_KEYS, getSetting } from "../db/settings.ts";
import { gmOf, rosterOf } from "../campaigns/roster.ts";
import { decide, type WinRule } from "../polls/win-rule.ts";

/**
 * A campaign's open date polls, listed and linked — and nothing else.
 *
 * This is phase 4's surface arriving in the console rather than more of the
 * campaign itself, which is why it forks off `p6/5` instead of extending it.
 *
 * **It lists and links. It never canonises.** Canonise is an organiser-only
 * button on the poll post, and giving the console a second way to trigger the
 * same decision would put it behind two different confirmations — which is how a
 * date gets chosen twice, or once by somebody who thought they were looking at a
 * preview. Every row here ends at a link to the post.
 *
 * Nothing in this file writes. `waitingOn` restates `autoResolve`'s three
 * questions for display, deliberately without calling it: `autoResolve` closes
 * polls, and a page load must never be the thing that decides a date.
 */
export interface PollDateRow {
  pollDateId: string;
  startsAt: number;
  endsAt: number;
  /** How many said this one works. Only yeses are stored; silence is not a no. */
  yes: number;
  /**
   * Whether the GM marked this date available.
   *
   * Null when the campaign has no GM — which is a real state, not a missing
   * value, and reads differently from "the GM said no": nobody was asked.
   */
  gmAvailable: boolean | null;
  outcome: "open" | "won" | "lost" | "withdrawn";
}

/**
 * Why a poll the rule already likes is still sitting there.
 *
 * `gm-not-available` is the one worth naming. A threshold crossed by five
 * players on a night the GM cannot make is not a win, it is a scheduling
 * accident, and a poll that closed itself on one would have to be reopened by
 * hand. The page says which of the three it is rather than showing a row that
 * looks stuck.
 */
export type WaitingOn = "responses" | "gm" | "organiser";

export interface OpenPoll {
  pollId: string;
  winRule: WinRule;
  winThreshold: number | null;
  /** What the rule needs, where it needs a number. Null when the rule has no bar. */
  required: number | null;
  closesAt: number | null;
  targetSessionId: string | null;
  gameId: string | null;
  gameDayKind: "single" | "multi" | null;
  /** The post, assembled from ids. The only action this page offers. */
  postUrl: string | null;
  rosterSize: number;
  dates: PollDateRow[];
  /** The dates the rule proposes right now. Ties are returned whole. */
  proposed: string[];
  waitingOn: WaitingOn;
}

export interface CampaignPolls {
  /**
   * The campaign's own flag, read live. It is written through `updateCampaign`
   * like every other campaign field, so the toggle lands in `audit_log` with
   * everything else and there is no second write path to review.
   */
  autoResolvePolls: boolean;
  polls: OpenPoll[];
}

export async function campaignPolls(env: Env, campaignId: string): Promise<CampaignPolls> {
  const campaign = await db(env)
    .select({ autoResolvePolls: schema.campaigns.autoResolvePolls })
    .from(schema.campaigns)
    .where(eq(schema.campaigns.id, campaignId))
    .get();
  if (!campaign) return { autoResolvePolls: false, polls: [] };

  const polls = await db(env)
    .select()
    .from(schema.datePolls)
    .where(and(eq(schema.datePolls.campaignId, campaignId), eq(schema.datePolls.status, "open")))
    .orderBy(asc(schema.datePolls.createdAt))
    .all();

  if (polls.length === 0) {
    return { autoResolvePolls: campaign.autoResolvePolls === 1, polls: [] };
  }

  const guildId = await getSetting<string>(env, SETTING_KEYS.guildId);
  const rosterSize = (await rosterOf(env, campaignId)).length;
  const gm = await gmOf(env, campaignId);

  const ids = polls.map((poll) => poll.id);
  const dates = await db(env)
    .select()
    .from(schema.pollDates)
    .where(inArray(schema.pollDates.pollId, ids))
    .orderBy(asc(schema.pollDates.startsAt))
    .all();

  // Every yes on every date of every open poll, in one query rather than one a
  // date. A campaign with three open polls of six dates each is eighteen round
  // trips otherwise, for a page somebody opened to read.
  const responses =
    dates.length === 0
      ? []
      : await db(env)
          .select()
          .from(schema.pollResponses)
          .where(
            inArray(
              schema.pollResponses.pollDateId,
              dates.map((date) => date.id),
            ),
          )
          .all();

  const yesBy = new Map<string, number>();
  const gmSaid = new Set<string>();
  for (const response of responses) {
    if (response.available !== 1) continue;
    yesBy.set(response.pollDateId, (yesBy.get(response.pollDateId) ?? 0) + 1);
    if (gm && response.userId === gm) gmSaid.add(response.pollDateId);
  }

  return {
    autoResolvePolls: campaign.autoResolvePolls === 1,
    polls: polls.map((poll) => {
      const mine = dates.filter((date) => date.pollId === poll.id);
      const rows: PollDateRow[] = mine.map((date) => ({
        pollDateId: date.id,
        startsAt: date.startsAt,
        endsAt: date.endsAt,
        yes: yesBy.get(date.id) ?? 0,
        // Null and not false when nobody is GM: the question was never put.
        gmAvailable: gm ? gmSaid.has(date.id) : null,
        outcome: date.outcome,
      }));

      const decision = decide({
        rule: poll.winRule,
        threshold: poll.winThreshold,
        rosterSize,
        tallies: rows.map((row) => ({ pollDateId: row.pollDateId, yes: row.yes })),
      });

      return {
        pollId: poll.id,
        winRule: poll.winRule,
        winThreshold: poll.winThreshold,
        required: decision.required,
        closesAt: poll.closesAt,
        targetSessionId: poll.targetSessionId,
        gameId: poll.gameId,
        gameDayKind: poll.gameDayKind,
        postUrl:
          guildId && poll.discordChannelId && poll.discordMessageId
            ? `https://discord.com/channels/${guildId}/${poll.discordChannelId}/${poll.discordMessageId}`
            : null,
        rosterSize,
        dates: rows,
        proposed: decision.won,
        waitingOn: waitingOn(decision.won, rows),
      };
    }),
  };
}

/**
 * The three states, in the order `autoResolve` asks them.
 *
 * No rule proposing anything is waiting on responses. A rule proposing a date
 * the GM has not marked is waiting on the GM. A rule proposing a date the GM
 * *has* marked is waiting on the organiser's click — and it is still waiting,
 * because nothing on this page is that click.
 */
function waitingOn(proposed: string[], rows: PollDateRow[]): WaitingOn {
  if (proposed.length === 0) return "responses";
  const byId = new Map(rows.map((row) => [row.pollDateId, row]));
  return proposed.some((id) => byId.get(id)?.gmAvailable === true) ? "organiser" : "gm";
}
