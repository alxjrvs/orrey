import { eq } from "drizzle-orm";
import type { Env } from "../env.ts";
import { db, schema } from "../db/index.ts";
import { gmOf } from "../campaigns/roster.ts";
import { rosterOf } from "../campaigns/roster.ts";
import { decide } from "./win-rule.ts";
import { applyOutcomes } from "./canonise.ts";
import { pollView } from "./rows.ts";
import type { PollView } from "./render.ts";

/**
 * When Canonise runs by itself, and never *how*.
 *
 * Everything this reads is somebody else's: the win rule decides what winning
 * means, `applyOutcomes` does the writing. This only answers "is now the moment"
 * — which is why it can sit beside the poll mechanism rather than on top of the
 * things that consume a closed poll.
 *
 * Three questions, and it takes **all three**:
 *
 *   1. Has the campaign opted in? `campaigns.auto_resolve_polls`, off by
 *      default, read live off the poll's `campaign_id` rather than copied onto
 *      the poll at open time — an admin who turns it off expects the next click
 *      to respect that, not the next poll.
 *   2. Does the rule now call a date won?
 *   3. **Has the GM marked that same date available?**
 *
 * The third is the whole point of the issue. A threshold crossed by five players
 * on a night the GM cannot make is not a win, it is a scheduling accident — and
 * a poll that closed itself on one would have to be reopened by hand, which is
 * worse than never having closed.
 *
 * Two of three, and the poll waits for the organiser.
 */
export type AutoResolve = "resolved" | "not-opted-in" | "no-winner" | "gm-not-available";

export async function autoResolve(
  env: Env,
  pollId: string,
): Promise<{ outcome: AutoResolve; view?: PollView }> {
  const poll = await db(env)
    .select()
    .from(schema.datePolls)
    .where(eq(schema.datePolls.id, pollId))
    .get();

  // A poll with no campaign has no flag to read and no GM to ask. It waits.
  if (!poll || poll.status !== "open" || !poll.campaignId) {
    return { outcome: "not-opted-in" };
  }

  const campaign = await db(env)
    .select({ autoResolvePolls: schema.campaigns.autoResolvePolls })
    .from(schema.campaigns)
    .where(eq(schema.campaigns.id, poll.campaignId))
    .get();
  if (!campaign || campaign.autoResolvePolls !== 1) return { outcome: "not-opted-in" };

  /**
   * Only a rule with a fixed bar can say "now".
   *
   * `best_available` names a winner the instant a single yes exists anywhere in
   * the poll — it means "whatever did best", and one answer is trivially the
   * best. `organiser_picks` names nobody until somebody picks. Both are relative
   * to what has been said so far, so asking them "has this been decided?" after
   * every click is asking the wrong question.
   *
   * That matters because `best_available` is the schema default for
   * `date_polls.win_rule` and what every targeted `/reschedule` poll gets. For an
   * opted-in campaign, the first person to answer — if that person is the GM and
   * they tick one date — satisfied all three questions below and closed the poll
   * before anybody else had seen it, with nothing in the tree able to reopen one.
   *
   * `min_players` and `quorum_of_roster` measure against a number that does not
   * move, so "enough people, now" is a real moment. The rest is the organiser's.
   */
  if (poll.winRule !== "min_players" && poll.winRule !== "quorum_of_roster") {
    return { outcome: "no-winner" };
  }

  const view = await pollView(env, pollId, new Date());
  if (!view) return { outcome: "not-opted-in" };

  const won = decide({
    rule: poll.winRule,
    threshold: poll.winThreshold,
    rosterSize: (await rosterOf(env, poll.campaignId)).length,
    tallies: view.dates.map((date) => ({ pollDateId: date.id, yes: date.yes })),
  }).won;

  // Nothing won, or the rule proposed several and a single click cannot be said
  // to have chosen between them. Either way this is the organiser's.
  if (won.length !== 1) return { outcome: "no-winner" };

  const gm = await gmOf(env, poll.campaignId);
  if (!gm || !(await saidYes(env, won[0] as string, gm))) {
    return { outcome: "gm-not-available" };
  }

  const closed = await applyOutcomes(env, pollId, won);
  return closed ? { outcome: "resolved", view: closed } : { outcome: "no-winner" };
}

async function saidYes(env: Env, pollDateId: string, userId: string): Promise<boolean> {
  const row = await db(env)
    .select({ userId: schema.pollResponses.userId })
    .from(schema.pollResponses)
    .where(eq(schema.pollResponses.pollDateId, pollDateId))
    .all();
  return row.some((answer) => answer.userId === userId);
}
