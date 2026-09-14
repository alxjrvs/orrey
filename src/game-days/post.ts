import { eq, sql } from "drizzle-orm";
import type { Env } from "../env.ts";
import { db, schema } from "../db/index.ts";
import {
  SETTING_DEFAULTS,
  SETTING_KEYS,
  getSetting,
  requireGuildId,
  settingOr,
} from "../db/settings.ts";
import { throughGovernor } from "../discord/governor.ts";
import {
  asDiscordFailure,
  isThreadAlreadyStarted,
  postMessage,
  startThreadFromMessage,
} from "../discord/rest.ts";
import { claim, find, record, recordFailure, release } from "../projection/publications.ts";
import { gameDayTitle } from "../projection/target.ts";
import { renderSignupPost } from "./render.ts";
import { capacityOf, signupsForDay } from "./signups.ts";

/**
 * The signup post, sent once, and the thread that hangs off it.
 *
 * This is `src/attendance/post.ts` with a different row in front of it, and it
 * is deliberately the same shape rather than a shared abstraction: the two posts
 * answer different questions, are addressed to different audiences and will
 * diverge again, and the thing worth keeping identical is the *ordering*, not
 * the code.
 *
 * That ordering, restated because it is the part that matters: everything that
 * can fail locally happens before the claim, because a claim is expensive to
 * hold and burning one on a render bug would suppress this post for good. The
 * ledger takes the message id first and `game_days` second, because the ledger
 * is the record that has to survive and the column is a convenience that can be
 * healed from it. And `game_days.discord_message_id` is not the guard — a claim
 * written before the call is, since a post that goes up and fails to record its
 * id would otherwise go up again with live buttons, and under send-only a second
 * post cannot be tidied away.
 */
/**
 * The job kind, named here rather than at the arming site, so `p5/9`'s
 * transition and this handler cannot drift apart over a typo.
 */
export const POST_SIGNUP_JOB = "game-day.post-signup";

export async function postSignupPost(env: Env, gameDayId: string): Promise<string | undefined> {
  const day = await dayOf(env, gameDayId);
  if (!day) return undefined;
  if (day.day.discordMessageId) return day.day.discordMessageId;

  const channelId =
    day.day.discordChannelId ??
    (await getSetting<string>(env, SETTING_KEYS.schedulingChannelId));
  if (!channelId) {
    throw new Error(
      `no channel to post game day ${gameDayId} in — the day has none and neither does settings`,
    );
  }

  const ref = { surface: "discord", kind: "message", targetId: gameDayId } as const;

  const payload = renderSignupPost({
    day: day.day,
    game: day.game,
    signups: await signupsForDay(env, gameDayId),
    capacity: await capacityOf(env, gameDayId),
    asOf: new Date(),
  });
  const guildId = await requireGuildId(env);

  const { mine, publication } = await claim(env, ref, channelId);

  if (!mine) {
    // It went up and only the `game_days` write was lost. Heal from the ledger.
    if (publication.remoteId) {
      await remember(env, gameDayId, { discordMessageId: publication.remoteId, channelId });
      return publication.remoteId;
    }
    // A claim with no id: a previous attempt reached Discord and we never heard
    // the outcome. The post may be up, so the failure this prefers is *no post*.
    return undefined;
  }

  let message;
  try {
    message = await throughGovernor(env, guildId, () => postMessage(env, channelId, payload));
  } catch (error) {
    // A 4xx is Discord reading the request and declining it, so nothing was
    // posted and the claim is in the way of a retry that should happen. Anything
    // else — a network error, an eviction, a 500 — leaves the claim standing,
    // because not hearing a clear no is not the same as it not having happened.
    if (refused(error)) await release(env, ref);
    else await recordFailure(env, ref, String(error));
    throw error;
  }

  await record(env, ref, message.id);
  await remember(env, gameDayId, { discordMessageId: message.id, channelId });

  return message.id;
}

/**
 * A thread per day, hanging off the signup post — so the reminders, the notices
 * and, once `p5/9` mints the session, the attendance post are one line in the
 * channel instead of six.
 */
const ARCHIVE_MINUTES = 10_080;

export async function startDayThread(env: Env, gameDayId: string): Promise<string | undefined> {
  const day = await dayOf(env, gameDayId);
  if (!day) return undefined;
  if (day.day.threadId) return day.day.threadId;

  // No post means nothing to hang a thread on. The post runs first and this
  // rides on the back of it, so this is the "post failed" case, not a race.
  const { discordMessageId, discordChannelId } = day.day;
  if (!discordMessageId || !discordChannelId) return undefined;

  const ref = { surface: "discord", kind: "thread", targetId: gameDayId } as const;
  const { mine, publication } = await claim(env, ref, discordChannelId);

  if (!mine) {
    if (publication.remoteId) {
      await remember(env, gameDayId, { threadId: publication.remoteId });
      return publication.remoteId;
    }
    return undefined;
  }

  const guildId = await requireGuildId(env);
  const timeZone = await settingOr<string>(
    env,
    SETTING_KEYS.timezone,
    SETTING_DEFAULTS[SETTING_KEYS.timezone],
  );

  let threadId: string;
  try {
    const thread = await throughGovernor(env, guildId, () =>
      startThreadFromMessage(env, discordChannelId, discordMessageId, {
        name: dayThreadName(day.day, day.game, timeZone),
        auto_archive_duration: ARCHIVE_MINUTES,
      }),
    );
    threadId = thread.id;
  } catch (error) {
    // Discord allows one thread per message, so this is the crash window
    // answering back: the thread exists, we made it, and its id is unknowable
    // from here. The claim stays, because a second attempt cannot succeed.
    if (isThreadAlreadyStarted(error)) return undefined;
    await release(env, ref);
    throw error;
  }

  await record(env, ref, threadId);
  await remember(env, gameDayId, { threadId });
  return threadId;
}

/**
 * `Blades in the Dark — 7 November`, in the **guild's** zone.
 *
 * A thread name is plain text — Discord renders no `<t:…>` in one — so this is
 * one of the few places Orrey has to pick a zone, and picking the server's would
 * name a Friday-evening day after Saturday for anybody far enough east.
 */
export function dayThreadName(
  day: typeof schema.gameDays.$inferSelect,
  game: typeof schema.games.$inferSelect | null,
  timeZone = "UTC",
): string {
  const when = new Date(day.startsAt * 1000).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    timeZone,
  });
  // Discord's ceiling is 100, and a truncated name beats a rejected creation.
  return `${gameDayTitle(day, game)} — ${when}`.slice(0, 100);
}

/** For the tests, and for anything that wants the id without the day row. */
export function dayThreadPublication(env: Env, gameDayId: string) {
  return find(env, { surface: "discord", kind: "thread", targetId: gameDayId });
}

async function dayOf(env: Env, gameDayId: string) {
  const row = await db(env)
    .select({ day: schema.gameDays, game: schema.games })
    .from(schema.gameDays)
    .leftJoin(schema.games, eq(schema.gameDays.gameId, schema.games.id))
    .where(eq(schema.gameDays.id, gameDayId))
    .get();
  return row ?? undefined;
}

function remember(
  env: Env,
  gameDayId: string,
  set: { discordMessageId?: string; threadId?: string; channelId?: string },
): Promise<unknown> {
  return db(env)
    .update(schema.gameDays)
    .set({
      ...(set.discordMessageId ? { discordMessageId: set.discordMessageId } : {}),
      ...(set.threadId ? { threadId: set.threadId } : {}),
      ...(set.channelId ? { discordChannelId: set.channelId } : {}),
      updatedAt: sql`(unixepoch())`,
    })
    .where(eq(schema.gameDays.id, gameDayId));
}

/** Discord read the request and declined it, so nothing was created. 5xx is not this. */
function refused(error: unknown): boolean {
  const failure = asDiscordFailure(error);
  return failure !== undefined && failure.status >= 400 && failure.status < 500;
}
