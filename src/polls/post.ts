import { eq, sql } from "drizzle-orm";
import type { Env } from "../env.ts";
import { db, schema } from "../db/index.ts";
import { requireGuildId } from "../db/settings.ts";
import { throughGovernor } from "../discord/governor.ts";
import { asDiscordFailure, postMessage } from "../discord/rest.ts";
import { claim, record, recordFailure, release } from "../projection/publications.ts";
import { pollClosedNotice, renderPollPost } from "./render.ts";
import { pollView } from "./rows.ts";

/**
 * Posting the poll post — once, and from a job.
 *
 * The same shape `src/attendance/post.ts` proved, for the same reasons: the id
 * is recorded and then forgotten, the guard is a claim in `publications` written
 * *before* the call rather than the stored id, and a 4xx releases the claim
 * while a 5xx or a lost connection does not. Not hearing a clear no is not the
 * same as it not having happened, and a second poll post with a live select is
 * the one thing send-only cannot undo — two posts means two selects, and the
 * answers split between them with nothing able to say which counted.
 *
 * From a job rather than from inside the interaction that opened the poll, so
 * every outbound message stays inside `GuildGovernor` and off the interaction's
 * three-second budget. Nothing arms `poll.post` yet; the two opening paths are
 * six and ten slices up.
 */
export async function postPollPost(env: Env, pollId: string): Promise<string | undefined> {
  const poll = await db(env)
    .select()
    .from(schema.datePolls)
    .where(eq(schema.datePolls.id, pollId))
    .get();
  if (!poll) return undefined;
  if (poll.discordMessageId) return poll.discordMessageId;

  // The channel comes from the poll rather than from a constant: a campaign's
  // poll belongs in the campaign's channel, and an untargeted one in the
  // scheduling channel. Whoever opened it decided that, and this does not
  // second-guess it.
  const channelId = poll.discordChannelId;
  if (!channelId) throw new Error(`poll ${pollId} has no channel to post in`);

  const ref = { surface: "discord", kind: "message", targetId: pollId, label: "poll" } as const;

  // Everything that can fail locally happens before the claim. A claim is
  // expensive to hold — nothing else may post while it stands — so burning one
  // on an unseeded guild id or a render bug would suppress this post for good.
  const view = await pollView(env, pollId, new Date());
  if (!view) return undefined;
  const payload = renderPollPost(view);
  const guildId = await requireGuildId(env);

  const { mine, publication } = await claim(env, ref, channelId);

  if (!mine) {
    // It went up and only the `date_polls` write was lost. Heal from the ledger.
    if (publication.remoteId) {
      await rememberMessageId(env, pollId, channelId, publication.remoteId);
      return publication.remoteId;
    }
    // A claim with no id: an earlier attempt reached Discord and we never
    // learned the outcome. The failure this prefers is no post.
    return undefined;
  }

  let message;
  try {
    message = await throughGovernor(env, guildId, () => postMessage(env, channelId, payload));
  } catch (error) {
    if (refused(error)) await release(env, ref);
    else await recordFailure(env, ref, String(error));
    throw error;
  }

  await record(env, ref, message.id);
  await rememberMessageId(env, pollId, channelId, message.id);

  return message.id;
}

function rememberMessageId(
  env: Env,
  pollId: string,
  channelId: string,
  messageId: string,
): Promise<unknown> {
  return db(env)
    .update(schema.datePolls)
    .set({
      discordChannelId: channelId,
      discordMessageId: messageId,
      updatedAt: sql`(unixepoch())`,
    })
    .where(eq(schema.datePolls.id, pollId));
}

/** Discord read the request and declined it, so nothing was created. 5xx is not this. */
function refused(error: unknown): boolean {
  const failure = asDiscordFailure(error);
  return failure !== undefined && failure.status >= 400 && failure.status < 500;
}

/**
 * The close notice: a new message, once.
 *
 * It never touches the poll post — there is nothing to edit under send-only and
 * no code path here that could. Guarded by its own labelled publication row, so
 * a redelivered `poll.close` job posts nothing further.
 */
export async function postCloseNotice(env: Env, pollId: string): Promise<string | undefined> {
  const poll = await db(env)
    .select()
    .from(schema.datePolls)
    .where(eq(schema.datePolls.id, pollId))
    .get();
  if (!poll || !poll.discordChannelId) return undefined;

  // A poll somebody already canonised does not need telling that answering has
  // stopped.
  if (poll.status !== "open") return undefined;

  const ref = {
    surface: "discord",
    kind: "message",
    targetId: pollId,
    label: "poll-closed",
  } as const;

  const view = await pollView(env, pollId, new Date());
  if (!view) return undefined;
  const payload = pollClosedNotice(view);
  const guildId = await requireGuildId(env);

  const { mine, publication } = await claim(env, ref, poll.discordChannelId);
  if (!mine) return publication.remoteId ?? undefined;

  let message;
  try {
    message = await throughGovernor(env, guildId, () =>
      postMessage(env, poll.discordChannelId as string, payload),
    );
  } catch (error) {
    if (refused(error)) await release(env, ref);
    else await recordFailure(env, ref, String(error));
    throw error;
  }

  await record(env, ref, message.id);
  return message.id;
}
