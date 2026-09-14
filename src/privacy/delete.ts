import { eq } from "drizzle-orm";
import type { Env } from "../env.ts";
import { db, schema } from "../db/index.ts";

/**
 * Everything Orrey holds that is keyed to one Discord id, in one place.
 *
 * Discord's developer terms require a delete-my-data path, and the only way to
 * keep one honest is for every phase that adds a user-keyed table to add its
 * delete here — and to have it counted on the receipt, so the person reading it
 * learns what was actually held. Signups, poll responses and campaign
 * membership each join as they land.
 */
export interface DeletionReceipt {
  discordId: string;
  /** Rows removed, per table. Zero everywhere means Orrey held nothing. */
  removed: Record<string, number>;
  deletedAt: string;
}

export async function deleteUserData(env: Env, discordId: string): Promise<DeletionReceipt> {
  const d = db(env);

  // All of these would cascade off the user row anyway, but a receipt that says
  // only "users (1)" is a receipt that does not tell someone what they just
  // erased. Deleting them here first is what makes the counts truthful.
  const attendance = await d
    .delete(schema.attendance)
    .where(eq(schema.attendance.userId, discordId))
    .returning({ sessionId: schema.attendance.sessionId });

  const campaignMembers = await d
    .delete(schema.campaignMembers)
    .where(eq(schema.campaignMembers.userId, discordId))
    .returning({ campaignId: schema.campaignMembers.campaignId });

  const signups = await d
    .delete(schema.signups)
    .where(eq(schema.signups.userId, discordId))
    .returning({ targetId: schema.signups.targetId });

  // A recap is somebody's own words about an evening, not a fact about the
  // campaign the way an `audit_log` row is — so forgetting the person removes
  // it rather than anonymising it, and the receipt says how many.
  const logs = await d
    .delete(schema.sessionLogs)
    .where(eq(schema.sessionLogs.author, discordId))
    .returning({ id: schema.sessionLogs.id });

  // The most sensitive thing Orrey holds about anybody, and the one whose
  // deletion has an effect outside Orrey: the pair stops working immediately and
  // the console stops recognising them.
  const tokens = await d
    .delete(schema.discordTokens)
    .where(eq(schema.discordTokens.userId, discordId))
    .returning({ userId: schema.discordTokens.userId });

  const users = await d
    .delete(schema.users)
    .where(eq(schema.users.discordId, discordId))
    .returning({ discordId: schema.users.discordId });

  // `audit_log` is deliberately absent. Its actor is `set null` on delete, so
  // the person is forgotten while the fact that a campaign was concluded is not
  // — erasing the entry would erase somebody else's history, not only theirs.
  return {
    discordId,
    removed: {
      users: users.length,
      attendance: attendance.length,
      campaign_members: campaignMembers.length,
      signups: signups.length,
      session_logs: logs.length,
      discord_tokens: tokens.length,
    },
    deletedAt: new Date().toISOString(),
  };
}

export function describeReceipt(receipt: DeletionReceipt): string {
  const rows = Object.values(receipt.removed).reduce((total, n) => total + n, 0);
  if (rows === 0) {
    return "Orrey held no data for you — nothing to delete. Your Discord account is untouched.";
  }
  const tables = Object.entries(receipt.removed)
    .filter(([, n]) => n > 0)
    .map(([table, n]) => `${table} (${n})`)
    .join(", ");
  return `Deleted: ${tables}. Anything Orrey learns about you from here on starts from nothing.`;
}
