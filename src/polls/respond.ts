import { eq } from "drizzle-orm";
import type { Env } from "../env.ts";
import { db, schema } from "../db/index.ts";
import { renderPollPost } from "./render.ts";
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
  | { ok: false; reason: "unknown" };

export async function answerPoll(
  env: Env,
  pollId: string,
  actor: InteractionUser,
  pollDateIds: string[],
): Promise<PollAnswer> {
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
