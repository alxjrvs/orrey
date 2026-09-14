import { and, eq, inArray, sql } from "drizzle-orm";
import type { Env } from "../env.ts";
import { db, schema } from "../db/index.ts";
import { SETTING_KEYS, getSetting } from "../db/settings.ts";
import { rosterOf } from "../campaigns/roster.ts";
import { decide } from "./win-rule.ts";
import { pollView } from "./rows.ts";
import { moveSession } from "./move.ts";
import { carryOver } from "./carry-over.ts";
import { mintStatements } from "./game-days.ts";
import { anchorFrom, isFormingPoll } from "./anchor.ts";
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

  /**
   * An anchor is decided before anything closes, because it is the one outcome
   * that can be refused. A rule that returned a tie has to go back to the
   * organiser, and a poll that closed first could not.
   *
   * Writing it before the close is also the safe way round the other way: a
   * crash between the two leaves a campaign anchored with its poll still open,
   * and Apply can simply be pressed again. The reverse would leave it closed
   * with no anchor and no way to make one.
   */
  const forming = !poll.targetSessionId && (await isFormingPoll(env, poll.campaignId));
  if (forming && won.length > 0) {
    const anchored = await anchorFrom(env, poll.campaignId as string, won);
    // Two dates cannot both be the slot. The poll stays open and the organiser
    // picks one.
    if (anchored === "too-many") return pollView(env, pollId, new Date());
  }

  /**
   * The consequence is a **job in the same batch**, not work done after it.
   *
   * A poll with a target is a poll about moving that session, and closing the
   * poll is what says the move is owed. Doing the move after the batch meant the
   * close committed first — and the guard at the top of this function is
   * `status !== "open"`, with Apply as its only caller. So a Discord refusal, a
   * 5xx or the interaction's own three-second budget left a poll permanently
   * closed with a move that could never be retried: the session's date unmoved
   * or moved with nothing re-projected, the reminders still pointing at the old
   * day, and no notice ever posted.
   *
   * Writing the job alongside the close makes "closed" and "a move is owed" one
   * fact. `drainJobs` then retries it with backoff until it lands, which is what
   * every other piece of time-shifted work in this repo already does.
   *
   * `wasStartsAt` rides in the payload because by the time the job runs the
   * session may already be at its new date, and the notice has to name where it
   * moved *from*.
   */
  const session = poll.targetSessionId
    ? await db(env)
        .select({ startsAt: schema.sessions.startsAt })
        .from(schema.sessions)
        .where(eq(schema.sessions.id, poll.targetSessionId))
        .get()
    : undefined;

  const follow =
    poll.targetSessionId && won.length > 0
      ? [
          d
            .insert(schema.jobs)
            .values({
              id: `${APPLY_JOB}:${pollId}`,
              kind: APPLY_JOB,
              payload: {
                pollId,
                sessionId: poll.targetSessionId,
                ...(session ? { wasStartsAt: session.startsAt } : {}),
              },
              idempotencyKey: `${APPLY_JOB}:${pollId}`,
              runAt: sql`(unixepoch())`,
            })
            .onConflictDoNothing(),
        ]
      : [];

  // A poll with no target was looking for a day rather than moving one, so what
  // its winners become is a game day — one per winning date, because a
  // multi-kind poll can win more than one and then that is genuinely two days.
  // Unless it was looking for a *slot*, which is the branch above: a campaign
  // that has not started needs an anchor, not a Saturday.
  //
  // The statements go in the batch below rather than being run after it. Minting
  // afterwards meant the close committed first, and Apply's own guard refuses a
  // closed poll — so a crash, an eviction or a D1 error in between left a poll
  // permanently closed with winning dates and no day, with nothing able to make
  // one. Nothing in the mint talks to Discord, so there is no reason for it to
  // be anywhere but here.
  const mint =
    !poll.targetSessionId && !forming && won.length > 0
      ? (await mintStatements(env, pollId, won)).statements
      : [];

  // One batch. A poll marked closed with half its dates still `open` is a poll
  // whose consequences would fire against a record nobody can read. `closed`
  // leads so the tuple is non-empty however the dates fall.
  await d.batch([closed, lost, ...marked, ...follow, ...mint]);

  return pollView(env, pollId, new Date());
}

/** What closing a poll sets in motion, once the close itself has committed. */
export const APPLY_JOB = "poll.apply";

/**
 * The move the closed poll decided on.
 *
 * Run from the drain rather than from the interaction, so it can be retried —
 * and written to be retried: `moveSession` re-arms with upserts and posts its
 * notice under a claim, so running this twice moves nothing twice and says
 * nothing twice.
 *
 * A poll whose winning dates have since been deleted, or whose session has gone,
 * is nothing to do rather than something to fail on.
 */
export async function applyFollowUp(
  env: Env,
  pollId: string,
  sessionId: string,
  wasStartsAt?: number,
): Promise<boolean> {
  const won = await db(env)
    .select({ id: schema.pollDates.id })
    .from(schema.pollDates)
    .where(and(eq(schema.pollDates.pollId, pollId), eq(schema.pollDates.outcome, "won")))
    .all();
  if (won.length === 0) return false;

  // The one date, because a session is on one day. A rule that returned a tie
  // was resolved in the override view before Apply ran; anything still tied here
  // is the organiser's own pick, and the earliest of it is the new date.
  const winner = await earliestOf(
    env,
    won.map((row) => row.id),
  );
  if (!winner) return false;

  const moved = await moveSession(env, sessionId, winner, wasStartsAt);

  // Only when the date actually changed. A re-apply that settles on the date the
  // session is already on must not wipe everybody's answers — and `moveSession`
  // returns false for exactly that case, including on a retry, because the date
  // it moved *from* comes out of the job's payload rather than off the session.
  if (moved) await carryOver(env, sessionId, winner.id);

  return moved;
}

async function earliestOf(env: Env, ids: string[]) {
  const rows = await db(env)
    .select({
      id: schema.pollDates.id,
      startsAt: schema.pollDates.startsAt,
      endsAt: schema.pollDates.endsAt,
    })
    .from(schema.pollDates)
    .where(inArray(schema.pollDates.id, ids))
    .all();

  return rows.sort((a, b) => a.startsAt - b.startsAt)[0];
}
