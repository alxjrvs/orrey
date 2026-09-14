import type { Env } from "../env.ts";
import { SETTING_KEYS, getSetting, requireGuildId } from "../db/settings.ts";
import { throughGovernor } from "../discord/governor.ts";
import { getGuildMember, isUnknownMember } from "../discord/rest.ts";

/**
 * What somebody is allowed to do, read from Discord with the **bot** token.
 *
 * This is the other half of "Discord is the only identity system", and the half
 * that is easy to get wrong. The console's OAuth scope is `identify`, so the
 * user's own token can say who they are and nothing else. Roles come from the
 * guild member endpoint, asked as the bot — which means a user cannot mint
 * themselves a permission by tampering with anything they hold, because they
 * hold nothing that is consulted.
 *
 * It is also why nothing is cached. A role removed in Discord is a permission
 * gone on the next request, not on the next login.
 */
export class NotConfigured extends Error {
  constructor(key: string) {
    super(`setting ${key} is not seeded — nobody can administer until it is`);
    this.name = "NotConfigured";
  }
}

export async function isOrganiser(env: Env, userId: string): Promise<boolean> {
  const roleId = await getSetting<string>(env, SETTING_KEYS.organiserRoleId);
  if (!roleId) {
    // Fail closed, and say which way. An unseeded role id means nobody is an
    // organiser — wrong in a way somebody notices immediately, as opposed to
    // everybody being one, which is wrong in a way nobody notices until it
    // matters. It is a missing setting rather than a refused person, so the
    // route answers 503 and names the key.
    throw new NotConfigured(SETTING_KEYS.organiserRoleId);
  }

  const guildId = await requireGuildId(env);

  try {
    const member = await throughGovernor(env, guildId, () =>
      getGuildMember(env, guildId, userId),
    );
    return member.roles.includes(roleId);
  } catch (error) {
    // Not in the guild is an answer, not a failure: they are not an organiser.
    if (isUnknownMember(error)) return false;
    throw error;
  }
}
