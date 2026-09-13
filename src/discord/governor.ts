import type { Env } from "../env.ts";

/**
 * Every outbound Discord call goes through the guild's governor, so that rate
 * limits are one guild's problem rather than each caller's: writes serialise,
 * and a 429 holds the whole guild rather than only the call that met it.
 *
 * The hold itself is taken inside the governor, in the same link of the chain
 * that met the 429 — a hold recorded from out here lands an RPC round trip
 * later, by which time the next queued call has already read the clock and gone.
 */
export function throughGovernor<T>(env: Env, guildId: string, work: () => Promise<T>): Promise<T> {
  return env.GUILD.get(env.GUILD.idFromName(guildId)).run(work);
}
