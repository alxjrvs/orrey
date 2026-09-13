/**
 * The SQL that puts one campaign and one session into D1 — phase 1 has no
 * console and no lifecycle, so the one hardcoded campaign is seeded by hand.
 *
 * It is a string builder rather than a drizzle insert because D1 is remote: the
 * operator pipes this into `wrangler d1 execute`, the same way the cutover
 * seeds `settings`. Keeping it here rather than in the script buys a test that
 * runs the statements against a real migrated database.
 */

export interface CampaignSeed {
  /** Defaults to the slug of the name — Orrey's own id, not a snowflake. */
  id?: string;
  name: string;
  kind: "run" | "play" | "tracked";
  discordChannelId?: string | null;
  discordRoleId?: string | null;
  colour?: number | null;
  locationType?: "external" | "voice";
  discordVoiceChannelId?: string | null;
}

export interface SessionSeed {
  id?: string;
  number?: number | null;
  /** Unix seconds, UTC. */
  startsAt: number;
  endsAt: number;
  location?: string | null;
}

export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!slug) throw new Error(`cannot make an id out of ${JSON.stringify(name)}`);
  return slug;
}

/** Numbered when the campaign numbers its sessions, dated when it does not. */
export function sessionIdFor(campaignId: string, session: SessionSeed): string {
  if (session.id) return session.id;
  if (session.number != null) return `${campaignId}-s${session.number}`;
  return `${campaignId}-${new Date(session.startsAt * 1000).toISOString().slice(0, 10)}`;
}

/**
 * Re-running is the normal case — the times move, the ids do not. So both
 * statements upsert, and both leave alone the columns that belong to something
 * other than the seed:
 *
 *   - `campaigns.state` is set on insert and never on update, so re-seeding a
 *     campaign on HIATUS does not quietly resume it.
 *   - `sessions.discord_event_id` / `discord_message_id` are never written here
 *     at all, so a re-seed cannot orphan a projected event or a posted message.
 */
export function seedStatements(campaign: CampaignSeed, session: SessionSeed): string[] {
  const campaignId = campaign.id ?? slugify(campaign.name);
  const locationType = campaign.locationType ?? "external";

  if (session.endsAt <= session.startsAt) {
    throw new Error("the session ends before it starts");
  }
  if (locationType === "external" && !session.location) {
    throw new Error("an EXTERNAL Discord event needs a location — pass one");
  }
  if (locationType === "voice" && !campaign.discordVoiceChannelId) {
    throw new Error("a VOICE campaign needs the voice channel id");
  }

  const sessionId = sessionIdFor(campaignId, session);

  return [
    `INSERT INTO campaigns
       (id, name, kind, discord_channel_id, discord_role_id, colour, location_type, discord_voice_channel_id, state)
     VALUES (${lit(campaignId)}, ${lit(campaign.name)}, ${lit(campaign.kind)}, ${lit(campaign.discordChannelId)}, ${lit(campaign.discordRoleId)}, ${lit(campaign.colour)}, ${lit(locationType)}, ${lit(campaign.discordVoiceChannelId)}, 'RUNNING')
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       kind = excluded.kind,
       discord_channel_id = excluded.discord_channel_id,
       discord_role_id = excluded.discord_role_id,
       colour = excluded.colour,
       location_type = excluded.location_type,
       discord_voice_channel_id = excluded.discord_voice_channel_id,
       updated_at = unixepoch()`,

    `INSERT INTO sessions
       (id, kind, campaign_id, number, starts_at, ends_at, location, state)
     VALUES (${lit(sessionId)}, 'campaign_session', ${lit(campaignId)}, ${lit(session.number ?? null)}, ${lit(session.startsAt)}, ${lit(session.endsAt)}, ${lit(session.location)}, 'SCHEDULED')
     ON CONFLICT(id) DO UPDATE SET
       number = excluded.number,
       starts_at = excluded.starts_at,
       ends_at = excluded.ends_at,
       location = excluded.location,
       updated_at = unixepoch()`,
  ];
}

/** The seed's values come from an operator's shell, so quote everything. */
function lit(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`not a number: ${value}`);
    return String(value);
  }
  return `'${value.replaceAll("'", "''")}'`;
}
