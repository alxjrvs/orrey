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

  // Attendance would cascade off the user row anyway, but a receipt that says
  // only "users (1)" is a receipt that does not tell someone what they just
  // erased. Deleting it here first is what makes the count truthful.
  const attendance = await d
    .delete(schema.attendance)
    .where(eq(schema.attendance.userId, discordId))
    .returning({ sessionId: schema.attendance.sessionId });

  const users = await d
    .delete(schema.users)
    .where(eq(schema.users.discordId, discordId))
    .returning({ discordId: schema.users.discordId });

  return {
    discordId,
    removed: { users: users.length, attendance: attendance.length },
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
