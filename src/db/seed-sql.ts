/**
 * The SQL that puts one campaign and one session into D1 — phase 1 has no
 * console and no lifecycle, so the one hardcoded campaign is seeded by hand.
 *
 * It is a string builder rather than a drizzle insert because D1 is remote: the
 * operator pipes this into `wrangler d1 execute`, the same way the cutover
 * seeds `settings`. Keeping it here rather than in the script buys a test that
 * runs the statements against a real migrated database.
 */

/**
 * A field left `undefined` is a field this run says nothing about, and a
 * re-seed leaves it exactly as it was. That distinction is the whole point:
 * the normal re-run is a short one — new date, same campaign — and it must not
 * quietly blank the ids the operator pasted in the first time.
 */
export interface CampaignSeed {
  /** Defaults to the slug of the name — Orrey's own id, not a snowflake. */
  id?: string | undefined;
  name: string;
  kind?: "run" | "play" | "tracked" | undefined;
  discordChannelId?: string | null | undefined;
  discordRoleId?: string | null | undefined;
  colour?: number | null | undefined;
  locationType?: "external" | "voice" | undefined;
  discordVoiceChannelId?: string | null | undefined;
}

export interface SessionSeed {
  id?: string | undefined;
  number?: number | null | undefined;
  /** Unix seconds, UTC. */
  startsAt: number;
  endsAt: number;
  location?: string | null | undefined;
}

export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!slug) throw new Error(`cannot make an id out of ${JSON.stringify(name)}`);
  return slug;
}

/**
 * The id is the identity, so it must not be made of anything a re-seed can
 * move. A number is stable when the date changes; a date is not — keying on it
 * meant moving the session inserted a *second* SCHEDULED row and left the first
 * one holding the Discord event and the posted message.
 */
export function sessionIdFor(campaignId: string, session: SessionSeed): string {
  if (session.id) return session.id;
  if (session.number != null) return `${campaignId}-s${session.number}`;
  throw new Error(
    "an un-numbered session needs an explicit id (--id): its date cannot be its identity, " +
      "because moving the date would seed a second session rather than move this one",
  );
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

  /**
   * Insert every column; overwrite only the ones this run actually spoke
   * about. `state` is never overwritten — it belongs to the lifecycle, not to
   * the seed — and neither is an id the operator did not repeat, because the
   * normal re-run is a short one (new date, same campaign) and it must not
   * blank the channel and role they pasted in the first time.
   */
  const columns: { column: string; value: string; spoken: boolean }[] = [
    { column: "name", value: lit(campaign.name), spoken: true },
    { column: "kind", value: lit(campaign.kind ?? "run"), spoken: campaign.kind !== undefined },
    {
      column: "location_type",
      value: lit(locationType),
      spoken: campaign.locationType !== undefined,
    },
    ...optionalColumns(campaign),
  ];

  const overwritten = columns.filter((c) => c.spoken);

  return [
    `INSERT INTO campaigns (id, ${columns.map((c) => c.column).join(", ")}, state)
     VALUES (${lit(campaignId)}, ${columns.map((c) => c.value).join(", ")}, 'RUNNING')
     ON CONFLICT(id) DO UPDATE SET
       ${overwritten.map((c) => `${c.column} = excluded.${c.column}`).join(",\n       ")},
       updated_at = unixepoch()`,

    `INSERT INTO sessions
       (id, kind, campaign_id, number, starts_at, ends_at, location, state)
     VALUES (${lit(sessionId)}, 'campaign_session', ${lit(campaignId)}, ${lit(session.number ?? null)}, ${lit(session.startsAt)}, ${lit(session.endsAt)}, ${lit(session.location ?? null)}, 'SCHEDULED')
     ON CONFLICT(id) DO UPDATE SET
       number = excluded.number,
       starts_at = excluded.starts_at,
       ends_at = excluded.ends_at,
       location = excluded.location,
       updated_at = unixepoch()`,

    // And ask for the projection. One standing job row per session, re-armed by
    // every re-seed: the clock picks it up within the minute and it becomes the
    // outbox messages for Discord and Google. A job rather than a direct send
    // because the seed reaches D1 through wrangler and has no queue binding —
    // and because time-based work Orrey can inspect and re-run lives in D1.
    projectionJob("session.project", sessionId),

    // And post the attendance post. Guarded by the recorded message id rather
    // than by the job, so re-arming this one cannot produce a second post.
    projectionJob("session.post-attendance", sessionId),
  ];
}

/** The ids and the colour: written when given, left alone when not. */
function optionalColumns(campaign: CampaignSeed) {
  const fields: [string, string | number | null | undefined][] = [
    ["discord_channel_id", campaign.discordChannelId],
    ["discord_role_id", campaign.discordRoleId],
    ["colour", campaign.colour],
    ["discord_voice_channel_id", campaign.discordVoiceChannelId],
  ];
  return fields.map(([column, value]) => ({
    column,
    value: lit(value ?? null),
    spoken: value !== undefined,
  }));
}

/** One standing job row per session per kind, re-armed rather than duplicated. */
function projectionJob(kind: string, sessionId: string): string {
  const id = `${kind}:${sessionId}`;
  return `INSERT INTO jobs (id, kind, payload, idempotency_key, run_at)
     VALUES (${lit(id)}, ${lit(kind)}, ${lit(JSON.stringify({ sessionId }))}, ${lit(id)}, unixepoch())
     ON CONFLICT(id) DO UPDATE SET
       state = 'pending',
       attempts = 0,
       last_error = NULL,
       run_at = unixepoch()`;
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
