import { and, eq, inArray, sql } from "drizzle-orm";
import type { Env } from "../env.ts";
import { db, schema } from "../db/index.ts";
import { SETTING_KEYS, getSetting } from "../db/settings.ts";
import { rosterOf } from "../campaigns/roster.ts";
import { decide } from "./win-rule.ts";
import { pollView } from "./rows.ts";
import { mintStatements } from "./game-days.ts";
import type { PollView } from "./render.ts";
import type { Interaction } from "../discord/types.ts";

/**
 * The rule proposes, the organiser disposes.
 *
 * Two clicks, because "winning" is the organiser's call. **Canonise** opens an
 * override view with the rule's answer preselected; **Apply** writes it. In
 * between, a person can change it — which is the whole point, and why
 * `win-rule.ts` returns ties whole rather than picking one.
 *
 * What happens *next* — moving a session, minting game days — is not here. This
 * ends at outcomes written and the poll closed, and both consequences hang off
 * that.
 */

/**
 * May this person close this poll?
 *
 * The poll's opener, or somebody holding the organiser role. The roles come from
 * `interaction.member.roles` — the payload Discord signed and the endpoint
 * already verified — so this costs no REST call and needs no `guilds` scope. A
 * user cannot mint themselves this permission by tampering with anything they
 * hold, because they hold nothing that is consulted.
 *
 * It matters more here than almost anywhere else: the Canonise button sits on a
 * post the whole server can see, so this check is the only thing between a
 * player and closing a poll.
 */
export async function mayCanonise(
  env: Env,
  poll: { openedBy: string | null },
  interaction: Interaction,
  userId: string,
): Promise<boolean> {
  if (poll.openedBy && poll.openedBy === userId) return true;

  const roleId = await getSetting<string>(env, SETTING_KEYS.organiserRoleId);
  // Fail closed. An unseeded role id means nobody but the opener can canonise —
  // wrong in a way somebody notices immediately, rather than everybody being an
  // organiser, which is wrong in a way nobody notices until it matters.
  if (!roleId) return false;

  return interaction.member?.roles?.includes(roleId) ?? false;
}

/** What the rule proposes for this poll, right now. */
export async function proposal(env: Env, pollId: string): Promise<string[]> {
  const poll = await db(env)
    .select()
    .from(schema.datePolls)
    .where(eq(schema.datePolls.id, pollId))
    .get();
  if (!poll) return [];

  const view = await pollView(env, pollId, new Date());
  if (!view) return [];

  return decide({
    rule: poll.winRule,
    threshold: poll.winThreshold,
    rosterSize: poll.campaignId ? (await rosterOf(env, poll.campaignId)).length : 0,
    tallies: view.dates.map((date) => ({ pollDateId: date.id, yes: date.yes })),
  }).won;
}

/**
 * Remember what the organiser has picked, without closing anything.
 *
 * The two-step needs somewhere to hold the choice between the select and the
 * Apply button, and there is exactly one legal place: **D1**. A Discord message
 * is not a place state can live — Orrey never reads one back — and a button
 * click carries no select values, so the message could not tell Apply what was
 * chosen even if reading it were allowed.
 *
 * So a pick writes `poll_dates.outcome` straight away and leaves
 * `date_polls.status` alone. The outcomes are provisional exactly as long as the
 * poll is still open, `status` is what says it has been decided, and the
 * consequences one slice up look for a *closed* poll's `won` rows.
 */
export async function stagePicks(
  env: Env,
  pollId: string,
  wonIds: string[],
): Promise<PollView | undefined> {
  const d = db(env);
  const poll = await d
    .select()
    .from(schema.datePolls)
    .where(eq(schema.datePolls.id, pollId))
    .get();
  if (!poll || poll.status !== "open") return pollView(env, pollId, new Date());

  const ids = await pollDateIds(env, pollId);
  const won = [...new Set(wonIds)].filter((id) => ids.includes(id));
  const lost = ids.filter((id) => !won.includes(id));

  await d.batch([
    d
      .update(schema.pollDates)
      .set({ outcome: "lost" })
      .where(inArray(schema.pollDates.id, lost.length ? lost : [""])),
    d
      .update(schema.pollDates)
      .set({ outcome: "won" })
      .where(inArray(schema.pollDates.id, won.length ? won : [""])),
  ]);

  return pollView(env, pollId, new Date());
}

/** What is currently marked won — what Apply will act on. */
export async function staged(env: Env, pollId: string): Promise<string[]> {
  const rows = await db(env)
    .select({ id: schema.pollDates.id, outcome: schema.pollDates.outcome })
    .from(schema.pollDates)
    .where(eq(schema.pollDates.pollId, pollId))
    .all();
  return rows.filter((row) => row.outcome === "won").map((row) => row.id);
}

async function pollDateIds(env: Env, pollId: string): Promise<string[]> {
  const rows = await db(env)
    .select({ id: schema.pollDates.id })
    .from(schema.pollDates)
    .where(eq(schema.pollDates.pollId, pollId))
    .all();
  return rows.map((row) => row.id);
}

/**
 * Write the outcomes and close the poll.
 *
 * Every date ends `won` or `lost` and none is left `open`: a poll that closed
 * without saying so about a date is a poll nobody can read afterwards, and the
 * consequences one slice up look for `won` rows rather than for a status.
 *
 * Split out from the rendering deliberately. `p4/17` calls this from inside a
 * *select* interaction and renders the closed post as that click's own response,
 * so this seam is load-bearing rather than tidy.
 *
 * A second Apply on a closed poll changes nothing — the guard is the poll's own
 * status, so a double-click or a redelivered interaction cannot rewrite an
 * outcome somebody has already acted on.
 */
export async function applyOutcomes(
  env: Env,
  pollId: string,
  wonIds: string[],
): Promise<PollView | undefined> {
  const d = db(env);
  const poll = await d
    .select()
    .from(schema.datePolls)
    .where(eq(schema.datePolls.id, pollId))
    .get();
  if (!poll) return undefined;
  if (poll.status !== "open") return pollView(env, pollId, new Date());

  const ids = await pollDateIds(env, pollId);
  // A stale override naming a date that has since gone must not mark another
  // poll's date as won.
  const won = [...new Set(wonIds)].filter((id) => ids.includes(id));

  // Guarded on the status this read saw, as well as being serialised by
  // `PollLock`. The lock is what makes the check and the write one unit; this is
  // what stops a caller that reaches `applyOutcomes` without going through it
  // from closing a poll twice.
  const closed = d
    .update(schema.datePolls)
    .set({ status: "closed", updatedAt: sql`(unixepoch())` })
    .where(and(eq(schema.datePolls.id, pollId), eq(schema.datePolls.status, "open")));

  // Everything that did not win, loses. Written as one statement over the ids
  // this poll actually has, so it cannot reach a date belonging to another.
  const lost = d
    .update(schema.pollDates)
    .set({ outcome: "lost" })
    .where(
      inArray(
        schema.pollDates.id,
        ids.filter((id) => !won.includes(id)).length
          ? ids.filter((id) => !won.includes(id))
          : [""],
      ),
    );

  const marked = won.length
    ? [d.update(schema.pollDates).set({ outcome: "won" }).where(inArray(schema.pollDates.id, won))]
    : [];

  // A poll with no target was looking for a day rather than moving one, so what
  // its winners become is a game day — one per winning date, because a
  // multi-kind poll can win more than one and then that is genuinely two days.
  //
  // The statements go in the batch below rather than being run after it. Minting
  // afterwards meant the close committed first, and Apply's own guard refuses a
  // closed poll — so a crash, an eviction or a D1 error in between left a poll
  // permanently closed with winning dates and no day, with nothing able to make
  // one. Nothing in the mint talks to Discord, so there is no reason for it to
  // be anywhere but here.
  const mint =
    !poll.targetSessionId && won.length > 0
      ? (await mintStatements(env, pollId, won)).statements
      : [];

  // One batch. A poll marked closed with half its dates still `open` is a poll
  // whose consequences would fire against a record nobody can read. `closed`
  // leads so the tuple is non-empty however the dates fall.
  await d.batch([closed, lost, ...marked, ...mint]);

  return pollView(env, pollId, new Date());
}
