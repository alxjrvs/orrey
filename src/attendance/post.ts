import { eq, sql } from "drizzle-orm";
import type { Env } from "../env.ts";
import { db, schema } from "../db/index.ts";
import { SETTING_KEYS, getSetting, requireGuildId } from "../db/settings.ts";
import { throughGovernor } from "../discord/governor.ts";
import { postMessage } from "../discord/rest.ts";
import { loadProjectionTarget } from "../projection/target.ts";
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

  const payload = renderAttendancePost({
    target,
    rows: await attendanceRows(env, sessionId),
    asOf: new Date(),
  });

  const guildId = await requireGuildId(env);
  const message = await throughGovernor(env, guildId, () => postMessage(env, channelId, payload));

  await db(env)
    .update(schema.sessions)
    .set({ discordMessageId: message.id, updatedAt: sql`(unixepoch())` })
    .where(eq(schema.sessions.id, sessionId));

  return message.id;
}
