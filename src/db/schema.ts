import { sql } from "drizzle-orm";
import { check, index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * The footings (phase 0), the smallest slice of the domain that can describe one
 * session of one running campaign and who is coming (phase 1), the ledger of what
 * Orrey has put into the world (#73), and what it takes to run *several*
 * campaigns — the game each plays, the cadence each keeps, who is on each, and a
 * record of who changed what (phase 2).
 *
 * The rest — date_polls, game_days, session_logs — lands in the phase that
 * actually reads it. See https://github.com/alxjrvs/orrey/issues/1.
 */

const now = sql`(unixepoch())`;

/** Discord id is the primary key; names are a cache, never a source of truth. */
export const users = sqliteTable("users", {
  discordId: text("discord_id").primaryKey(),
  username: text("username"),
  globalName: text("global_name"),
  /** Unguessable; the only credential an ICS subscriber can present. */
  feedToken: text("feed_token").notNull().unique(),
  /** open | closed — learned from error 50007, then treated as permanent. */
  dmState: text("dm_state", { enum: ["unknown", "open", "closed"] })
    .notNull()
    .default("unknown"),
  createdAt: integer("created_at").notNull().default(now),
  updatedAt: integer("updated_at").notNull().default(now),
});

/** Single-guild key/value: guild id, channel ids, horizon size, feature flags. */
export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value", { mode: "json" }).notNull(),
  updatedAt: integer("updated_at").notNull().default(now),
});

/**
 * Time-based work lives in D1 rather than a queue so it can be inspected,
 * cancelled and re-run. Idempotency key makes a double-drain harmless.
 */
export const jobs = sqliteTable(
  "jobs",
  {
    id: text("id").primaryKey(),
    kind: text("kind").notNull(),
    payload: text("payload", { mode: "json" }).notNull(),
    idempotencyKey: text("idempotency_key").notNull().unique(),
    runAt: integer("run_at").notNull(),
    state: text("state", { enum: ["pending", "claimed", "done", "failed", "cancelled"] })
      .notNull()
      .default("pending"),
    attempts: integer("attempts").notNull().default(0),
    claimedUntil: integer("claimed_until"),
    lastError: text("last_error"),
    createdAt: integer("created_at").notNull().default(now),
  },
  (t) => [index("jobs_due_idx").on(t.state, t.runAt)],
);


/**
 * A game is a thing you play, not a thing you schedule. Its player counts and
 * its usual length are what a campaign inherits — the quorum a GM starts from,
 * and the end time a materialised session gets — and in phase 5 they are where a
 * single game day's capacity comes from.
 *
 * Separate from `campaigns` because two campaigns can run the same game, and
 * because a game day names one without any campaign existing at all.
 */
export const games = sqliteTable(
  "games",
  {
    /** A slug, like every other id Orrey mints. */
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    /** Both nullable: plenty of games are happy with however many turn up. */
    minPlayers: integer("min_players"),
    maxPlayers: integer("max_players"),
    /** How long a session of it usually runs, in minutes. */
    defaultDurationMinutes: integer("default_duration_minutes"),
    createdAt: integer("created_at").notNull().default(now),
    updatedAt: integer("updated_at").notNull().default(now),
  },
  (t) => [
    // A game that needs more players than it seats cannot be run, and phase 5
    // reads both numbers to decide a game day's capacity. Catching it here is
    // cheaper than explaining an empty waitlist later.
    check("games_players_ck", sql`${t.minPlayers} IS NULL OR ${t.maxPlayers} IS NULL
       OR ${t.minPlayers} <= ${t.maxPlayers}`),
  ],
);

/**
 * A campaign: the thing sessions hang off. Phase 1 needed only enough of it to
 * project one session; this is what it takes to run several — the game it plays,
 * the cadence it keeps, and the numbers that say how big it is.
 *
 * Cadence is an anchor plus an interval rather than a weekday, because Discord
 * cannot own recurrence (weekly means exactly one weekday, and `count`/`end`
 * cannot be set externally) and because an anchor in the past is how a campaign
 * that started before Orrey existed keeps its rhythm. There is no per-campaign
 * timezone: recurrence is wall-clock work in one guild's zone, and that zone is
 * already `SETTING_KEYS.timezone`.
 */
export const campaigns = sqliteTable(
  "campaigns",
  {
    /** A slug, not a snowflake: Orrey's own id, stable across Discord objects. */
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    /** run = we play it here, play = someone else runs it, tracked = calendar only. */
    kind: text("kind", { enum: ["run", "play", "tracked"] }).notNull(),
    discordChannelId: text("discord_channel_id"),
    discordRoleId: text("discord_role_id"),
    /** Discord's role colour, as the integer Discord stores. */
    colour: integer("colour"),
    /** Decides the Discord scheduled event's entity type: EXTERNAL vs VOICE. */
    locationType: text("location_type", { enum: ["external", "voice"] })
      .notNull()
      .default("external"),
    /** Voice channel id when location_type is `voice`; otherwise unused. */
    discordVoiceChannelId: text("discord_voice_channel_id"),
    /**
     * What is being played. Nullable, and `set null` on delete: a campaign whose
     * game row is removed is still a campaign, and losing the game must never take
     * the sessions people are coming to with it.
     */
    gameId: text("game_id").references(() => games.id, { onDelete: "set null" }),
    /**
     * Unix seconds. Any occurrence of the cadence — commonly the first session
     * ever played, which may be long past. The materialiser counts forward from it
     * in `interval_weeks` steps and skips what has already happened, which is what
     * makes "session 47" arithmetic rather than a counter somebody maintains.
     */
    recurrenceAnchor: integer("recurrence_anchor"),
    intervalWeeks: integer("interval_weeks"),
    /** How many `in` it takes for the session to be worth holding. Phase 3 acts on it. */
    quorum: integer("quorum"),
    /** How many seats the campaign has at all. */
    capacity: integer("capacity"),
    /** A campaign with an end in sight. Reaching it stops materialisation, not the campaign. */
    maxSessions: integer("max_sessions"),
    /**
     * History starts empty, so numbering has to be told where it is. The four real
     * campaigns continue Hermuz's numbering from a number entered by hand; a new
     * campaign starts at 1.
     */
    firstSessionNumber: integer("first_session_number").notNull().default(1),
    /**
     * FORMING, not RUNNING: `isProjectable` publishes only what is RUNNING, so
     * the default decides which way an insert that forgets to say fails. A
     * campaign nobody has started is the safe side of that.
     */
    state: text("state", { enum: ["FORMING", "RUNNING", "HIATUS", "CONCLUDED"] })
      .notNull()
      .default("FORMING"),
    createdAt: integer("created_at").notNull().default(now),
    updatedAt: integer("updated_at").notNull().default(now),
  },
  /**
   * No CHECK on `interval_weeks`, and not for want of wanting one.
   *
   * Adding a constraint to an existing SQLite table means rebuilding it, and a
   * rebuild drops the old table — which in D1 fires `ON DELETE CASCADE` on
   * everything that references it, because `PRAGMA foreign_keys=OFF` is a no-op
   * there. Rebuilding `campaigns` would delete every session, every attendance
   * row and every calendar link, silently, and report success. That is proved
   * against the real thing; docs/GOTCHAS.md has it.
   *
   * So "an interval of zero or less is a materialiser that never advances" is
   * enforced by the code that writes the column, and this table only ever grows
   * by `ALTER TABLE ADD COLUMN`. `games` keeps its CHECK because it is a new
   * table with nothing pointing at it.
   */
  () => [],
);

/**
 * `kind` is explicit from day one so that game days (phases 4–5) add a parent
 * rather than reinterpret this one. The CHECK is the invariant that survives
 * that: a session hangs off exactly the parent its kind names.
 */
export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    kind: text("kind", { enum: ["campaign_session", "one_off"] }).notNull(),
    campaignId: text("campaign_id").references(() => campaigns.id, { onDelete: "cascade" }),
    /** Session number within the campaign. Display only — never an ordering key. */
    number: integer("number"),
    /** Unix seconds, UTC. The timezone is a rendering concern, held in settings. */
    startsAt: integer("starts_at").notNull(),
    endsAt: integer("ends_at").notNull(),
    /** Free text for an EXTERNAL event; ignored for a VOICE one. */
    location: text("location"),
    state: text("state", {
      enum: ["SCHEDULED", "CONFIRMED", "JEOPARDY", "CANCELLED", "PLAYED"],
    })
      .notNull()
      .default("SCHEDULED"),
    /** Reconciled. May be replaced: Discord's terminal statuses are not undoable. */
    discordEventId: text("discord_event_id"),
    /** The content hash last written to that event; what makes a re-write skippable. */
    discordEventFingerprint: text("discord_event_fingerprint"),
    /** The attendance post. Recorded, then forgotten — messages are send-only. */
    discordMessageId: text("discord_message_id"),
    threadId: text("thread_id"),
    createdAt: integer("created_at").notNull().default(now),
    updatedAt: integer("updated_at").notNull().default(now),
  },
  (t) => [
    index("sessions_starts_idx").on(t.startsAt),
    index("sessions_campaign_idx").on(t.campaignId, t.startsAt),
    check(
      "sessions_parent_ck",
      sql`(${t.kind} = 'campaign_session' AND ${t.campaignId} IS NOT NULL)
       OR (${t.kind} = 'one_off' AND ${t.campaignId} IS NULL)`,
    ),
  ],
);

/**
 * One row per person per session. `intent` is what they said; `attended` is what
 * happened, and phase 3 fills it in — auto-assumed at session end, correctable
 * by the GM. Both are null until someone says otherwise; neither implies the
 * other.
 */
export const attendance = sqliteTable(
  "attendance",
  {
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.discordId, { onDelete: "cascade" }),
    intent: text("intent", { enum: ["in", "out", "maybe"] }),
    attended: integer("attended"),
    attendedSource: text("attended_source", { enum: ["auto", "gm"] }),
    note: text("note"),
    updatedAt: integer("updated_at").notNull().default(now),
  },
  (t) => [primaryKey({ columns: [t.sessionId, t.userId] })],
);

/**
 * One Google event per session, at an id Orrey mints rather than discovers
 * (`src/google/event-id.ts`) — so an upsert is `insert`, and on 409 `update`.
 * The fingerprint is what makes the write skippable, and what phase 7 compares
 * against to tell Orrey's own echo from a human's edit.
 */
export const calendarLinks = sqliteTable("calendar_links", {
  sessionId: text("session_id")
    .primaryKey()
    .references(() => sessions.id, { onDelete: "cascade" }),
  gcalEventId: text("gcal_event_id").notNull().unique(),
  fingerprint: text("fingerprint"),
  syncedAt: integer("synced_at"),
  lastError: text("last_error"),
});

/**
 * Everything Orrey has put into the world, and whether it is still there.
 *
 * Orrey's database is the source of truth, so anything Orrey published must stay
 * findable from it. Today it is not: `calendar_links` cascades off `sessions`,
 * so deleting a session destroys the only record that a Google event exists out
 * there, and `sessions.discord_event_id` goes with it. After that no reconcile
 * can account for what is still on the calendar. That is #73.
 *
 * So this table holds **no foreign key**. `target_id` is a plain string, not a
 * `references()`, and that absence is the entire point: a row that cascades
 * cannot be the record of something that does not. The next person to tidy the
 * schema will want to add the constraint back. Do not.
 *
 * The row is also written *before* the remote call, not after it. A `claimed`
 * row with no `remote_id` is Orrey saying "someone is already publishing this" —
 * which is what stands between a crash mid-POST and a second scheduled event or
 * a second attendance post with live buttons.
 */
export const publications = sqliteTable(
  "publications",
  {
    /** Derived: `<surface>:<kind>:<target_id>`. Two claims for one thing collide. */
    id: text("id").primaryKey(),
    surface: text("surface", { enum: ["discord", "google"] }).notNull(),
    /**
     * `thread` joins these in phase 3. There is no CHECK on this column, so
     * widening it is a TypeScript change and not a migration — which is worth
     * knowing rather than discovering: the enum here is advice, and the ledger's
     * integrity comes from the derived `id`, not from this.
     */
    kind: text("kind", { enum: ["event", "message", "thread"] }).notNull(),
    /** A session id today. Deliberately not a foreign key — see above. */
    targetId: text("target_id").notNull(),
    /** Null while claimed; the remote object's own id once it exists. */
    remoteId: text("remote_id"),
    /** Where it was put, so a retraction knows where to look without the row. */
    channelId: text("channel_id"),
    state: text("state", { enum: ["claimed", "published", "retracted"] })
      .notNull()
      .default("claimed"),
    claimedAt: integer("claimed_at").notNull().default(now),
    publishedAt: integer("published_at"),
    retractedAt: integer("retracted_at"),
    lastError: text("last_error"),
  },
  (t) => [index("publications_target_idx").on(t.targetId, t.state)],
);

/**
 * The roster, and the answer to "who is this campaign for".
 *
 * A campaign entered straight into RUNNING — which is all four of the real ones
 * — gets its roster from here rather than from signups. That is what "started
 * campaigns skip stages 1 and 2 structurally" means once it reaches the schema:
 * there is no signup history to reconstruct, and none is needed.
 */
export const campaignMembers = sqliteTable(
  "campaign_members",
  {
    campaignId: text("campaign_id")
      .notNull()
      .references(() => campaigns.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.discordId, { onDelete: "cascade" }),
    role: text("role", { enum: ["gm", "player"] })
      .notNull()
      .default("player"),
    characterName: text("character_name"),
    joinedAt: integer("joined_at").notNull().default(now),
  },
  (t) => [primaryKey({ columns: [t.campaignId, t.userId] })],
);

/**
 * Claiming a place in something that has not started yet.
 *
 * A signup attaches to a campaign at formation and to a game day. It never
 * attaches to a session — "am I coming to this one?" is attendance, a different
 * question asked of a different audience — and the CHECK is that invariant
 * written where it cannot be argued with.
 *
 * `target_id` is deliberately not a foreign key: it points at whichever table
 * `target_type` names, and the CHECK is what keeps that honest. Both values are
 * in the constraint even though phase 2 writes only the first. Widening a CHECK
 * in SQLite means rebuilding the table, and a rebuild on a table with rows in it
 * is the operation this stack has already had to hand-correct twice — so the
 * constraint states the invariant once, now, rather than being edited later by
 * someone who has stopped thinking about what it is for. `game_days` arrives in
 * phase 5; until then nothing can write a row that points at one, because
 * nothing mints that kind of id.
 */
export const signups = sqliteTable(
  "signups",
  {
    targetType: text("target_type", { enum: ["campaign_forming", "game_day"] }).notNull(),
    targetId: text("target_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => users.discordId, { onDelete: "cascade" }),
    /** `in` holds a place; `waitlisted` is queued behind capacity; `out` withdrew. */
    state: text("state", { enum: ["in", "waitlisted", "out"] })
      .notNull()
      .default("in"),
    /** Waitlist order. Null for anyone who is not on the waitlist. */
    position: integer("position"),
    characterName: text("character_name"),
    createdAt: integer("created_at").notNull().default(now),
    updatedAt: integer("updated_at").notNull().default(now),
  },
  (t) => [
    // One claim per person per thing: clicking twice is not two seats.
    primaryKey({ columns: [t.targetType, t.targetId, t.userId] }),
    index("signups_target_idx").on(t.targetType, t.targetId, t.position),
    check(
      "signups_target_ck",
      sql`${t.targetType} IN ('campaign_forming', 'game_day')`,
    ),
  ],
);

/**
 * Who changed what.
 *
 * Written by the domain functions rather than by the console routes, so a change
 * the bot makes is recorded exactly like one a person makes — which is the only
 * way the log can be read as what actually happened rather than as what happened
 * to go through the web.
 *
 * It stores ids and a JSON diff, never a rendered sentence: the question it
 * answers is "who changed this, and to what", and a sentence written today is
 * unreadable after the next rename.
 */
export const auditLog = sqliteTable(
  "audit_log",
  {
    id: text("id").primaryKey(),
    /**
     * Null is the clock. The materialiser and the reminders act on nobody's
     * behalf, and saying so is more honest than attributing them to whoever
     * happened to create the campaign.
     */
    actorUserId: text("actor_user_id").references(() => users.discordId, {
      onDelete: "set null",
    }),
    /** `campaign.start`, `member.remove` — the domain function's own name for it. */
    action: text("action").notNull(),
    targetType: text("target_type").notNull(),
    targetId: text("target_id").notNull(),
    /** `{ before, after }`, or whatever the action needs to be legible later. */
    detail: text("detail", { mode: "json" }),
    createdAt: integer("created_at").notNull().default(now),
  },
  (t) => [index("audit_target_idx").on(t.targetType, t.targetId, t.createdAt)],
);

/**
 * The Discord OAuth pair for one person, replaced whole on every refresh.
 *
 * Discord rotates refresh tokens — a refresh returns a *new* one and retires the
 * old — so there is no "add a token" here, only "replace the pair". Keeping the
 * old refresh token is how somebody ends up permanently logged out a week later.
 *
 * It is user-keyed, so `src/privacy/delete.ts` deletes it and counts it: this is
 * the most sensitive thing Orrey holds about anybody.
 */
export const discordTokens = sqliteTable("discord_tokens", {
  userId: text("user_id")
    .primaryKey()
    .references(() => users.discordId, { onDelete: "cascade" }),
  accessToken: text("access_token").notNull(),
  refreshToken: text("refresh_token").notNull(),
  /** Unix seconds. Discord's access tokens last about a week. */
  expiresAt: integer("expires_at").notNull(),
  updatedAt: integer("updated_at").notNull().default(now),
});
