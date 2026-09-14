import { eq, sql } from "drizzle-orm";
import type { Env } from "../env.ts";
import { db, schema } from "../db/index.ts";
import { requireGuildId } from "../db/settings.ts";
import { throughGovernor } from "../discord/governor.ts";
import { isClosedDm, openDm, postMessage } from "../discord/rest.ts";
import type { MessagePayload } from "./render.ts";

/**
 * A DM first, and the channel as the fallback.
 *
 * Bot DMs cannot be pre-checked. There is no endpoint that says whether somebody
 * accepts them; opening the channel succeeds either way, and the refusal arrives
 * as `50007` on the message itself. So the only way to learn is to try, once —
 * and then to remember, because trying again every reminder would spend a
 * rate-limit slot on a refusal Discord has already given.
 *
 * `users.dm_state` is that memory. `closed` is treated as permanent: it is a
 * setting somebody chose rather than a blip, and Orrey has no way to be told it
 * changed. The cost of being wrong is that they get a mention instead of a DM,
 * which is the fallback anyway.
 */
export type DmOutcome = "sent" | "closed" | "already-closed";

export async function tryDm(
  env: Env,
  userId: string,
  payload: MessagePayload,
): Promise<DmOutcome> {
  const user = await db(env)
    .select({ dmState: schema.users.dmState })
    .from(schema.users)
    .where(eq(schema.users.discordId, userId))
    .get();

  // Asked and answered. No call, no slot spent.
  if (user?.dmState === "closed") return "already-closed";

  const guildId = await requireGuildId(env);

  try {
    await throughGovernor(env, guildId, async () => {
      const channel = await openDm(env, userId);
      return postMessage(env, channel.id, payload);
    });
  } catch (error) {
    if (!isClosedDm(error)) throw error;
    await rememberDmState(env, userId, "closed");
    return "closed";
  }

  // A DM that went through is worth recording too: it turns the next reminder's
  // first attempt from a guess into a known-good one.
  if (user?.dmState !== "open") await rememberDmState(env, userId, "open");
  return "sent";
}

async function rememberDmState(
  env: Env,
  userId: string,
  dmState: "open" | "closed",
): Promise<void> {
  await db(env)
    .update(schema.users)
    .set({ dmState, updatedAt: sql`(unixepoch())` })
    .where(eq(schema.users.discordId, userId));
}
