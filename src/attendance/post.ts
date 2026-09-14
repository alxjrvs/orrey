import { eq, sql } from "drizzle-orm";
import type { Env } from "../env.ts";
import { db, schema } from "../db/index.ts";
import { SETTING_KEYS, getSetting, requireGuildId } from "../db/settings.ts";
import { throughGovernor } from "../discord/governor.ts";
import { asDiscordFailure, postMessage } from "../discord/rest.ts";
import { loadProjectionTarget } from "../projection/target.ts";
import { claim, record, recordFailure, release } from "../projection/publications.ts";
import { renderAttendancePost } from "./render.ts";
import { attendanceRows } from "./rows.ts";

/**
 * Posting the attendance post — once. The id is recorded and then forgotten:
 * this message is never reconciled, never edited from the outside, and never
 * read back. If it is wrong, the cure is a new post, not an edit.
 *
 * Which is also why posting twice is guarded rather than idempotent-by-write:
 * a second post is a second post, and only the newest one's buttons should be
 * the ones people are clicking.
 *
 * `sessions.discord_message_id` is not enough of a guard on its own, and that is
 * #73's second finding: `postMessage` returns, the id write fails, the job
 * re-runs, and a second post goes up with live buttons. So the guard is a claim
 * in `publications`, written *before* the call — and the ordering afterwards is
 * deliberate. The ledger takes the id first and `sessions` second, because the
 * ledger is the record that has to survive and the session column is a
 * convenience that can be healed from it.
 */
export async function postAttendancePost(env: Env, sessionId: string): Promise<string | undefined> {
  const target = await loadProjectionTarget(env, sessionId);
  if (!target) return undefined;
  if (target.session.discordMessageId) return target.session.discordMessageId;

  const channelId =
    target.campaign?.discordChannelId ??
    (await getSetting<string>(env, SETTING_KEYS.schedulingChannelId));
  if (!channelId) {
    throw new Error(`no channel to post ${sessionId} in — the campaign has none and neither does settings`);
  }

  const ref = { surface: "discord", kind: "message", targetId: sessionId } as const;

  // Everything that can fail locally happens *before* the claim. A claim is
  // expensive to hold — nothing else may post while it stands — so burning one
  // on an unseeded guild id or a render bug would suppress this post for good,
  // with no Discord call ever made and nothing to show for it.
  const payload = renderAttendancePost({
    target,
    rows: await attendanceRows(env, sessionId),
    asOf: new Date(),
  });
  const guildId = await requireGuildId(env);

  const { mine, publication } = await claim(env, ref, channelId);

  if (!mine) {
    // The post already went up and only the `sessions` write was lost. Heal
    // from the ledger — that is what it is for — rather than posting again.
    if (publication.remoteId) {
      await rememberMessageId(env, sessionId, publication.remoteId);
      return publication.remoteId;
    }

    // A claim with no id: a previous attempt reached Discord and we never
    // learned the outcome. The post may be up. Under send-only a second one
    // cannot be tidied away, so the failure this prefers is *no post* — which a
    // person can re-arm by clearing the claim, having looked at the channel.
    return undefined;
  }

  let message;
  try {
    message = await throughGovernor(env, guildId, () => postMessage(env, channelId, payload));
  } catch (error) {
    // Discord *refused* — a 4xx, so it read the request and declined it and
    // nothing was posted. The claim is then in the way of a retry that should be
    // allowed to happen.
    //
    // Anything else leaves the claim standing: a network error, a worker evicted
    // mid-flight, and a 5xx, which is the subtle one — Discord answering 500
    // does not mean it did not create the message first. Not hearing a clear no
    // is not the same as it not having happened, and a second attendance post
    // with live buttons is the one thing send-only cannot undo.
    if (refused(error)) await release(env, ref);
    else await recordFailure(env, ref, String(error));
    throw error;
  }

  await record(env, ref, message.id);
  await rememberMessageId(env, sessionId, message.id);

  return message.id;
}

function rememberMessageId(env: Env, sessionId: string, messageId: string): Promise<unknown> {
  return db(env)
    .update(schema.sessions)
    .set({ discordMessageId: messageId, updatedAt: sql`(unixepoch())` })
    .where(eq(schema.sessions.id, sessionId));
}

/** Discord read the request and declined it, so nothing was created. 5xx is not this. */
function refused(error: unknown): boolean {
  const failure = asDiscordFailure(error);
  return failure !== undefined && failure.status >= 400 && failure.status < 500;
}
