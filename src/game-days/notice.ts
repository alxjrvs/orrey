import { eq } from "drizzle-orm";
import type { Env } from "../env.ts";
import { db, schema } from "../db/index.ts";
import { SETTING_KEYS, getSetting, requireGuildId } from "../db/settings.ts";
import { throughGovernor } from "../discord/governor.ts";
import { asDiscordFailure, postMessage } from "../discord/rest.ts";
import { claim, record, recordFailure, release } from "../projection/publications.ts";
import { gameDayTitle } from "../projection/target.ts";
import type { MessagePayload } from "../attendance/render.ts";

/**
 * A notice about a day: a new message in its thread, sent once and never
 * touched.
 *
 * `postNoticeOnce` in `src/attendance` does this for a session and is not
 * reusable here — it takes a `ProjectionTarget`, and a day in SEATING has no
 * session until `p5/9` mints one. The ordering is the same and is the part worth
 * repeating: the destination is resolved *before* the claim, because a claim is
 * expensive to hold and taking one to discover there is nowhere to post would
 * block the attempt that comes after somebody makes the thread.
 */
export async function postDayNoticeOnce(
  env: Env,
  gameDayId: string,
  label: string,
  payload: MessagePayload,
): Promise<string | undefined> {
  const destination = await destinationForDay(env, gameDayId);
  if (!destination) return undefined;
  const guildId = await requireGuildId(env);

  const ref = { surface: "discord", kind: "message", targetId: gameDayId, label } as const;
  const { mine, publication } = await claim(env, ref, destination);

  // Somebody already posted it, or tried to. A notice arriving twice is worse
  // than one arriving late, and under send-only the second cannot be taken back.
  if (!mine) return publication.remoteId ?? undefined;

  let messageId: string;
  try {
    const message = await throughGovernor(env, guildId, () =>
      postMessage(env, destination, payload),
    );
    messageId = message.id;
  } catch (error) {
    const failure = asDiscordFailure(error);
    if (failure && failure.status >= 400 && failure.status < 500) await release(env, ref);
    else await recordFailure(env, ref, String(error));
    throw error;
  }

  await record(env, ref, messageId);
  return messageId;
}

/**
 * Where a post about this day goes: its thread, or the channel its signup post
 * went to, or the scheduling channel — in that order, and the first one that
 * exists.
 */
export async function destinationForDay(
  env: Env,
  gameDayId: string,
): Promise<string | undefined> {
  const day = await db(env)
    .select({
      threadId: schema.gameDays.threadId,
      discordChannelId: schema.gameDays.discordChannelId,
    })
    .from(schema.gameDays)
    .where(eq(schema.gameDays.id, gameDayId))
    .get();
  if (!day) return undefined;

  return (
    day.threadId ??
    day.discordChannelId ??
    (await getSetting<string>(env, SETTING_KEYS.schedulingChannelId))
  );
}

/**
 * "You're in." Addressed to whoever just came off the waitlist, by name.
 *
 * It is a new post rather than a rewrite of the signup post, and that is the
 * whole design rather than a shortcut. The person who clicked Out already had
 * the post rewritten as their own interaction's response; the promoted player is
 * told by a message addressed to them; everybody else finds out on Refresh.
 * Anything changing from outside posts a new message.
 *
 * `allowed_mentions.users` is exactly the ids being promoted and `parse` is
 * empty, so this post can ping the people it names and nothing else — not
 * @everyone, not a role, and not a user id that wandered in from a character
 * name somebody typed.
 */
export function promotedNotice(
  day: typeof schema.gameDays.$inferSelect,
  game: typeof schema.games.$inferSelect | null,
  userIds: string[],
): MessagePayload {
  const who = userIds.map((id) => `<@${id}>`).join(", ");

  return {
    content: [
      `**You're in.** ${who} — ${seats(userIds.length)} came free at ${gameDayTitle(day, game)}.`,
      `<t:${day.startsAt}:F>${day.venue ? `, ${day.venue}` : ""}.`,
      "",
      "-# Can't make it after all? Out on the signup post puts the seat back.",
    ].join("\n"),
    components: [],
    allowed_mentions: { parse: [], roles: [], users: userIds },
  };
}

function seats(count: number): string {
  return count === 1 ? "a seat" : `${count} seats`;
}
