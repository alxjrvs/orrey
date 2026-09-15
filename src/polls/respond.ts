import { eq } from "drizzle-orm";
import type { Env } from "../env.ts";
import { db, schema } from "../db/index.ts";
import { renderOverride, renderPollPost } from "./render.ts";
import { CLOSE_JOB } from "./schedule.ts";
import { applyOutcomes, mayCanonise, proposal, stagePicks, staged } from "./canonise.ts";
import { pollView } from "./rows.ts";
import type { Interaction } from "../discord/types.ts";
import type { MessagePayload } from "../attendance/render.ts";
import type { InteractionUser } from "../discord/types.ts";

/**
 * Answering a poll, and re-reading one.
 *
 * The click *is* the re-render: the response is `UPDATE_MESSAGE` carrying what
 * was just written, which is the one rewrite send-only allows because it answers
 * an interaction that came from that very message. Nothing here reads the
 * message it is rewriting — the post is a rendering of D1 and never a record.
 */
export type PollAnswer =
  | { ok: true; payload: MessagePayload }
  | { ok: false; reason: "unknown" }
  | { ok: false; reason: "closed" };

export async function answerPoll(
  env: Env,
  pollId: string,
  actor: InteractionUser,
  pollDateIds: string[],
  now = new Date(),
): Promise<PollAnswer> {
  // Closing is enforced *here*, and it has to be: the poll post is still sitting
  // in the channel with a live select, Orrey cannot disarm it, and the message is
  // not a place state can live. So the handler is the gate.
  const poll = await loadPoll(env, pollId);
  if (!poll) return { ok: false, reason: "unknown" };
  if (isClosedToAnswers(poll, now)) return { ok: false, reason: "closed" };

  const lock = env.POLL_LOCK.get(env.POLL_LOCK.idFromName(pollId));
  const view = await lock.select({ pollId, actor, pollDateIds });
  return view ? { ok: true, payload: renderPollPost(view) } : { ok: false, reason: "unknown" };
}

export async function refreshPoll(
  env: Env,
  pollId: string,
  actor: InteractionUser,
): Promise<PollAnswer> {
  const lock = env.POLL_LOCK.get(env.POLL_LOCK.idFromName(pollId));
  const view = await lock.read(pollId, actor.id);
  return view ? { ok: true, payload: renderPollPost(view) } : { ok: false, reason: "unknown" };
}

/** Whether this poll exists at all, for the paths that need to say so first. */
export function loadPoll(env: Env, pollId: string) {
  return db(env).select().from(schema.datePolls).where(eq(schema.datePolls.id, pollId)).get();
}

/**
 * Canonise — the organiser's own view of the poll, with the rule's answer
 * preselected and an Apply button.
 *
 * Refused for everybody else, ephemerally and with nothing written. The button
 * sits on a post the whole server can see, so this check is the only thing
 * between a player and closing a poll.
 */
export async function openOverride(
  env: Env,
  pollId: string,
  actor: InteractionUser,
  interaction: Interaction,
): Promise<PollAnswer | { ok: false; reason: "refused" }> {
  const poll = await loadPoll(env, pollId);
  if (!poll) return { ok: false, reason: "unknown" };

  if (!(await mayCanonise(env, poll, interaction, actor.id))) {
    return { ok: false, reason: "refused" };
  }

  // A poll already closed has nothing to override. Show it as it stands rather
  // than offering to decide it again.
  if (poll.status !== "open") {
    const closed = await pollView(env, pollId, new Date(), actor.id);
    return closed ? { ok: true, payload: renderPollPost(closed) } : { ok: false, reason: "unknown" };
  }

  // Stage the rule's answer, so Apply without touching the select applies what
  // the rule proposed rather than nothing.
  const proposed = await proposal(env, pollId);
  const view = await stagePicks(env, pollId, proposed);
  return view
    ? { ok: true, payload: renderOverride(view, proposed) }
    : { ok: false, reason: "unknown" };
}

/** The organiser changing the rule's answer. Still nothing closed. */
export async function pickWinners(
  env: Env,
  pollId: string,
  actor: InteractionUser,
  interaction: Interaction,
  wonIds: string[],
): Promise<PollAnswer | { ok: false; reason: "refused" }> {
  const poll = await loadPoll(env, pollId);
  if (!poll) return { ok: false, reason: "unknown" };
  if (!(await mayCanonise(env, poll, interaction, actor.id))) {
    return { ok: false, reason: "refused" };
  }

  // The same guard `openOverride` has, for a sharper reason. `stagePicks`
  // already no-ops on a closed poll, so nothing is written either way — but
  // `renderOverride` would still be returned, and the handler turns that into an
  // UPDATE_MESSAGE. A post reading "Closed. The dates below are what it decided."
  // would be rewritten into a live override view with a working Apply button, on
  // a poll whose outcomes are final and whose consequences have already fired.
  if (poll.status !== "open") {
    const closed = await pollView(env, pollId, new Date(), actor.id);
    return closed ? { ok: true, payload: renderPollPost(closed) } : { ok: false, reason: "unknown" };
  }

  const view = await stagePicks(env, pollId, wonIds);
  return view
    ? { ok: true, payload: renderOverride(view, wonIds) }
    : { ok: false, reason: "unknown" };
}

/**
 * Apply — the poll closes, and the post stops answering.
 *
 * A button click carries no select values, and Orrey never reads a message back,
 * so what Apply acts on is what the picks wrote to D1. That is not a
 * convenience: D1 is the only place this state is allowed to live.
 */
export async function applyOverride(
  env: Env,
  pollId: string,
  actor: InteractionUser,
  interaction: Interaction,
): Promise<PollAnswer | { ok: false; reason: "refused" }> {
  const poll = await loadPoll(env, pollId);
  if (!poll) return { ok: false, reason: "unknown" };
  if (!(await mayCanonise(env, poll, interaction, actor.id))) {
    return { ok: false, reason: "refused" };
  }

  // Through the poll's own Durable Object, so the "is it still open" check and
  // the close that follows it are one unit. Two Apply clicks landing together
  // would otherwise both read `open` and both fire what closing enables.
  const lock = env.POLL_LOCK.get(env.POLL_LOCK.idFromName(pollId));
  const view = await lock.apply(pollId, await staged(env, pollId));
  return view ? { ok: true, payload: renderPollPost(view) } : { ok: false, reason: "unknown" };
}

/**
 * Whether this poll still takes answers.
 *
 * Canonise stays available after `closes_at`: **closing the answers is not
 * closing the poll**. The organiser still has to decide, and a deadline that
 * also locked them out would leave a dead post nobody could settle.
 */
export function isClosedToAnswers(
  poll: { status: "open" | "closed"; closesAt: number | null },
  now: Date,
): boolean {
  if (poll.status !== "open") return true;
  return poll.closesAt !== null && poll.closesAt <= Math.floor(now.getTime() / 1000);
}

export { CLOSE_JOB };
