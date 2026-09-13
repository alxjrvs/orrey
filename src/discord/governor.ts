import type { Env } from "../env.ts";
import { asDiscordFailure } from "./rest.ts";

/**
 * Every outbound Discord call goes through the guild's governor, so that rate
 * limits are one guild's problem rather than each caller's: writes serialise,
 * and a 429 holds the whole guild rather than only the call that met it.
 *
 * The hold is recorded after `run` settles, not inside it. The callback runs in
 * the caller's isolate, so it can hand the retry-after back by assignment —
 * which also avoids calling the governor from inside the work it is running.
 */
export async function throughGovernor<T>(
  env: Env,
  guildId: string,
  work: () => Promise<T>,
): Promise<T> {
  const governor = env.GUILD.get(env.GUILD.idFromName(guildId));
  let holdUntilMs = 0;

  try {
    return await governor.run(async () => {
      try {
        return await work();
      } catch (error) {
        const retryAfterMs = asDiscordFailure(error)?.retryAfterMs;
        if (retryAfterMs !== undefined) holdUntilMs = Date.now() + retryAfterMs;
        throw error;
      }
    });
  } finally {
    if (holdUntilMs) await governor.holdUntil(holdUntilMs);
  }
}
