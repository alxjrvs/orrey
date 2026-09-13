import { sql } from "drizzle-orm";
import { check, index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * The footings (phase 0) and the smallest slice of the domain that can describe
 * one session of one running campaign and who is coming (phase 1).
 *
 * The rest — signups, date_polls, games, campaign_members, session_logs,
 * audit_log, game days — lands in the phase that actually reads it. See
 * https://github.com/alxjrvs/orrey/issues/1.
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
 * Only the columns phase 1 reads. Cadence (anchor, interval_weeks), quorum and
 * the rest of the lifecycle arrive with phases 2 and 3; `state` is here because
 * the projector must not project a campaign that is not running, and phase 1
 * seeds it as `RUNNING`.
 */
export const campaigns = sqliteTable("campaigns", {
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
  state: text("state", { enum: ["FORMING", "RUNNING", "HIATUS", "CONCLUDED"] })
    .notNull()
    .default("RUNNING"),
  createdAt: integer("created_at").notNull().default(now),
  updatedAt: integer("updated_at").notNull().default(now),
});

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
