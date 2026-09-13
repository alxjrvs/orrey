import { eq, sql } from "drizzle-orm";
import type { Env } from "../env.ts";
import { db, schema } from "./index.ts";
import type { InteractionUser } from "../discord/types.ts";

/**
 * Discord id is the primary key and the identity; the names are a cache that
 * every interaction refreshes, because a display name can change under us and
 * Orrey must never treat its copy as the truth.
 *
 * The feed token is minted once and never rotated here — a calendar client
 * cannot re-subscribe on its own, so changing it silently would break a feed.
 */
export async function rememberUser(env: Env, actor: InteractionUser): Promise<void> {
  const d = db(env);
  await d
    .insert(schema.users)
    .values({
      discordId: actor.id,
      username: actor.username,
      globalName: actor.global_name ?? null,
      feedToken: mintFeedToken(),
    })
    .onConflictDoUpdate({
      target: schema.users.discordId,
      set: {
        username: actor.username,
        globalName: actor.global_name ?? null,
        updatedAt: sql`(unixepoch())`,
      },
    });
}

export function getUser(env: Env, discordId: string) {
  return db(env).select().from(schema.users).where(eq(schema.users.discordId, discordId)).get();
}

/** 160 bits, base32hex, unguessable — the only credential an ICS subscriber has. */
export function mintFeedToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  const alphabet = "0123456789abcdefghijklmnopqrstuv";
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return out;
}
