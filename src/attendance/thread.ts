import { eq, sql } from "drizzle-orm";
import type { Env } from "../env.ts";
import { db, schema } from "../db/index.ts";
import { SETTING_KEYS, getSetting, requireGuildId } from "../db/settings.ts";
import { throughGovernor } from "../discord/governor.ts";
import { isThreadAlreadyStarted, postMessage, startThreadFromMessage } from "../discord/rest.ts";
import { claim, find, record, release } from "../projection/publications.ts";
import { sessionTitle, type ProjectionTarget } from "../projection/target.ts";

/**
 * A thread per session.
 *
 * Roughly twenty-six attendance posts a year per campaign, plus reminders,
 * jeopardy notices, reschedules and a recap. Left in the channel they bury it;
 * in a thread they are one line per session and the channel reads as a list of
 * sessions, which is what it is.
 *
 * The thread hangs off the attendance post rather than being made first,
 * because that way the post *is* the thread's opening message — one object
 * instead of two, and the title is Orrey's either way since it names the thread
 * at creation.
 *
 * Orrey never unarchives it and never edits anything in it. A thread archives
 * itself after a week of quiet, which is the right amount of time after a
 * session and exactly as much attention as it deserves afterwards.
 */
const ARCHIVE_MINUTES = 10_080;

export async function startSessionThread(
  env: Env,
  target: ProjectionTarget,
): Promise<string | undefined> {
  const { session } = target;
  if (session.threadId) return session.threadId;

  // No post means nothing to hang a thread on. The post job runs first and this
  // rides on the back of it, so this is the "post failed" case, not a race.
  if (!session.discordMessageId) return undefined;

  const channelId = await channelOf(env, target);
  if (!channelId) return undefined;

  const ref = { surface: "discord", kind: "thread", targetId: session.id } as const;
  const { mine, publication } = await claim(env, ref, channelId);

  if (!mine) {
    // Made already, and only the `sessions` write was lost. Heal from the ledger
    // — the same shape as the attendance post, for the same reason.
    if (publication.remoteId) {
      await rememberThreadId(env, session.id, publication.remoteId);
      return publication.remoteId;
    }
    return undefined;
  }

  const guildId = await requireGuildId(env);
  let threadId: string;
  try {
    const thread = await throughGovernor(env, guildId, () =>
      startThreadFromMessage(env, channelId, session.discordMessageId as string, {
        name: threadName(target),
        auto_archive_duration: ARCHIVE_MINUTES,
      }),
    );
    threadId = thread.id;
  } catch (error) {
    // Discord allows one thread per message, so this is the crash window
    // answering back: the thread exists, we made it, and we still do not know
    // its id. The claim stays, because a second attempt cannot succeed either
    // and blanking it would only produce this same answer again.
    if (isThreadAlreadyStarted(error)) return undefined;
    await release(env, ref);
    throw error;
  }

  await record(env, ref, threadId);
  await rememberThreadId(env, session.id, threadId);
  return threadId;
}

/**
 * Where a later post about this session goes. Everything after the attendance
 * post — reminders, jeopardy, the confirmed notice, the recap — belongs in the
 * thread; the campaign channel is the fallback for a session that never got one.
 */
export async function postToSession(
  env: Env,
  target: ProjectionTarget,
  payload: Record<string, unknown>,
): Promise<string | undefined> {
  const destination = target.session.threadId ?? (await channelOf(env, target));
  if (!destination) return undefined;

  const guildId = await requireGuildId(env);
  const message = await throughGovernor(env, guildId, () =>
    postMessage(env, destination, payload),
  );
  return message.id;
}

/** `Session 12 — 20 September`, which is what a channel's thread list reads as. */
export function threadName(target: ProjectionTarget): string {
  const when = new Date(target.session.startsAt * 1000).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    timeZone: "UTC",
  });
  const title = sessionTitle(target);
  // Discord's ceiling is 100 characters, and a truncated name is better than a
  // rejected creation.
  return `${title} — ${when}`.slice(0, 100);
}

async function channelOf(env: Env, target: ProjectionTarget): Promise<string | undefined> {
  return (
    target.campaign?.discordChannelId ??
    (await getSetting<string>(env, SETTING_KEYS.schedulingChannelId))
  );
}

function rememberThreadId(env: Env, sessionId: string, threadId: string): Promise<unknown> {
  return db(env)
    .update(schema.sessions)
    .set({ threadId, updatedAt: sql`(unixepoch())` })
    .where(eq(schema.sessions.id, sessionId));
}

/** For the tests, and for anything that wants the id without the session row. */
export function threadPublication(env: Env, sessionId: string) {
  return find(env, { surface: "discord", kind: "thread", targetId: sessionId });
}
