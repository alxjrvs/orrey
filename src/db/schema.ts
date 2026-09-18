import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

/**
 * The footings (phase 0), the smallest slice of the domain that can describe one
 * session of one running campaign and who is coming (phase 1), the ledger of what
 * Orrey has put into the world (#73), and what it takes to run *several*
 * campaigns — the game each plays, the cadence each keeps, who is on each, and a
 * record of who changed what (phase 2).
 *
 * ...and asking a group which day works (phase 4).
 *
 * The rest — game_days' venue and seating, session_logs — lands in the phase
 * that actually reads it. See https://github.com/alxjrvs/orrey/issues/1.
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
    /**
     * Whether a date poll for this campaign may close itself.
     *
     * Off by default, and read live rather than copied onto a poll when it
     * opens: an organiser who turns it off expects the *next* click to respect
     * that, not the next poll.
     */
    autoResolvePolls: integer("auto_resolve_polls").notNull().default(0),
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
    /**
     * A one-off's parent. A game day gets a session row so that attendance, the
     * thread, the Discord event and the Google event reuse the machinery they
     * already have rather than growing a second copy of it.
     */
    gameDayId: text("game_day_id").references(() => gameDays.id, { onDelete: "cascade" }),
    /** Session number within the campaign. Display only — never an ordering key. */
    number: integer("number"),
    /** Unix seconds, UTC. The timezone is a rendering concern, held in settings. */
    startsAt: integer("starts_at").notNull(),
    endsAt: integer("ends_at").notNull(),
    /** Free text for an EXTERNAL event; ignored for a VOICE one. */
    location: text("location"),
    /**
     * `LOCKED` joins the five in phase 6, and it costs **no migration**: this
     * column carries no CHECK — `sessions_parent_ck` is about `kind` and
     * `campaign_id` — so the set of words it holds is a TypeScript fact, the
     * same way `signups.state` was when phase 5 widened it.
     *
     * It means the table has stopped moving: intent changes are refused, the
     * jeopardy check no longer treats it as waiting, and a click cannot confirm
     * it. It is not terminal — `attendance.assume` still plays it — and nothing
     * unlocks, for the reason a locked game day does not: a table that can be
     * un-stopped by a click never really stopped.
     */
    state: text("state", {
      enum: ["SCHEDULED", "CONFIRMED", "JEOPARDY", "LOCKED", "CANCELLED", "PLAYED"],
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
    /**
     * RFC 5545 `SEQUENCE` for the ICS feed: how many times this session has
     * moved or been called off since subscribers first saw it.
     *
     * A stored counter rather than `updated_at`, which was the obvious
     * alternative and is wrong: RFC 5545 caps `SEQUENCE` at a signed 32-bit
     * integer, and unix seconds cross that in 2038. A client that will not take
     * the number stops taking the update.
     *
     * It rises in one place — `bumpIcsSequence` in `src/ics/sequence.ts` — and a
     * roster change is not one of them. `SEQUENCE` is about the event, and a
     * client re-prompting every attendee because somebody clicked Maybe is a
     * client nobody keeps subscribed.
     */
    icsSequence: integer("ics_sequence").notNull().default(0),
    createdAt: integer("created_at").notNull().default(now),
    updatedAt: integer("updated_at").notNull().default(now),
  },
  (t) => [
    index("sessions_starts_idx").on(t.startsAt),
    index("sessions_campaign_idx").on(t.campaignId, t.startsAt),
    /**
     * Phase 1's CHECK, **untouched**. It still says exactly what it said: a
     * campaign session has a campaign and a one-off does not.
     *
     * It does not say a one-off has a game day, and it deliberately is not made
     * to. SQLite cannot alter a CHECK, so any change here — including *removing*
     * it — is a rebuild of `sessions`, and `docs/GOTCHAS.md` records that D1
     * ignores `PRAGMA foreign_keys=OFF`: dropping the old table would cascade
     * away every `attendance` row, every `calendar_links` row, and every
     * `date_polls` row that targets a session. That is the entire attendance
     * history of the server, deleted to tighten a constraint.
     *
     * So the second half of "exactly one parent, and the one its kind names"
     * lives in `hasExactlyOneParent` below, next to `singleNamesGame` and for the
     * same reason.
     */
    check(
      "sessions_parent_ck",
      sql`(${t.kind} = 'campaign_session' AND ${t.campaignId} IS NOT NULL)
       OR (${t.kind} = 'one_off' AND ${t.campaignId} IS NULL)`,
    ),
  ],
);

/**
 * Exactly one parent, and the one its `kind` names.
 *
 * The campaign half is a CHECK; this is the whole rule, including the half
 * SQLite will not let Orrey add without deleting the attendance history to do
 * it. Every path that writes a session goes through this.
 */
export function hasExactlyOneParent(session: {
  kind: string;
  campaignId: string | null;
  gameDayId: string | null;
}): boolean {
  return session.kind === "campaign_session"
    ? session.campaignId !== null && session.gameDayId === null
    : session.campaignId === null && session.gameDayId !== null;
}

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
    /**
     * What this person actually played, on a day where several tables ran.
     *
     * Free text on a row already keyed `(session_id, user_id)`, so it is per
     * person by construction — which is #7's open question settled: there is no
     * `tables` table and no per-table seating. Nothing reads this until `p5/13`.
     */
    tablesPlayed: text("tables_played"),
    note: text("note"),
    updatedAt: integer("updated_at").notNull().default(now),
  },
  (t) => [primaryKey({ columns: [t.sessionId, t.userId] })],
);

/**
 * What was written down about a session after it was played.
 *
 * Exactly the four columns #46 names, and **no `kind`**. In this phase a recap
 * is the only thing that writes here; the day a reschedule notice wants to be
 * logged too is the day that column is worth arguing about, and adding it now
 * would be schema ahead of the phase that reads it.
 *
 * The index is `(session_id, created_at)` because every read is "this session's
 * log, oldest first" and there is no other question to ask of it.
 */
export const sessionLogs = sqliteTable(
  "session_logs",
  {
    /**
     * Monotonic, and that is the point rather than a detail.
     *
     * `created_at` is `unixepoch()` seconds like every other timestamp in this
     * file, so two recaps written in the same second are indistinguishable by
     * it — and a log is the one table where the order things were written *is*
     * the content. Every other id here is a slug or a UUID; neither sorts by
     * write order, and `ORDER BY created_at, id` over a UUID returns a stable
     * arbitrary order rather than the right one.
     *
     * So this is the one integer key in the schema. It is declared and ordered
     * on explicitly — the thing to avoid is leaning on an *implicit* rowid,
     * which is what an `ORDER BY` with no tie-break would be doing.
     */
    id: integer("id").primaryKey({ autoIncrement: true }),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    /**
     * Who wrote it. Cascades, and is counted on the delete-my-data receipt: a
     * recap is somebody's own words about an evening, not a fact about the
     * campaign the way an `audit_log` row is, so forgetting the person means
     * removing it rather than anonymising it.
     */
    author: text("author")
      .notNull()
      .references(() => users.discordId, { onDelete: "cascade" }),
    body: text("body").notNull(),
    createdAt: integer("created_at").notNull().default(now),
  },
  (t) => [index("session_logs_session_idx").on(t.sessionId, t.createdAt)],
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
 *
 * Phase 5 arrived and that foresight held: `src/game-days/signups.ts` writes the
 * second kind of row without a migration, and the CHECK is byte-for-byte the one
 * `0006_roster_and_audit.sql` created.
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
    /**
     * Arrival order within a target: assigned when the claim is made and never
     * touched again while it stands.
     *
     * Phase 2 wrote it as "waitlist order, null for anyone else"; phase 5 is the
     * phase that reads it, and reads it as arrival order for everyone who claims
     * a place at a game day, seated or queued. That is what lets a promotion be
     * one column changing — see `src/game-days/signups.ts`. A forming campaign
     * has no capacity and so no queue, so its signups still leave this null.
     */
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

/**
 * A day that is being organised, as opposed to a session of a campaign.
 *
 * This is what a winning date *produces*. A game day is the open-invite thing —
 * one table or several, on a date that had to be found rather than assumed — and
 * the poll that found the date points at it from `poll_dates.game_day_id`.
 *
 * Everything else about a game day is phase 5's: capacity, venue, host, the game
 * being played, seating, and the `signups` CHECK that binds a signup to a
 * campaign at formation or to a game day and never to a session. None of that is
 * read here, and a column added now "because phase 5 will want it" is a column
 * no test in this phase can justify.
 *
 * `sessions_parent_ck` is untouched. A game day does not become a session's
 * parent until phase 5, and widening that CHECK before anything writes such a
 * session would be widening it on faith.
 */
export const gameDays = sqliteTable("game_days", {
  id: text("id").primaryKey(),
  /** One table, or several running alongside each other on the same day. */
  kind: text("kind", { enum: ["single", "multi"] })
    .notNull()
    .default("single"),
  startsAt: integer("starts_at").notNull(),
  endsAt: integer("ends_at").notNull(),
  title: text("title"),
  /**
   * PROPOSED once a date has won, SEATING while people claim places, LOCKED when
   * the table is settled, PLAYED afterwards — or CANCELLED, which like every
   * terminal state in this schema is entered by a person and never by a job.
   */
  state: text("state", {
    enum: ["PROPOSED", "SEATING", "LOCKED", "PLAYED", "CANCELLED"],
  })
    .notNull()
    .default("PROPOSED"),

  /** What the EXTERNAL Discord event carries as its location. */
  venue: text("venue"),
  /** Whoever is running it. Null until somebody says, and null again if they leave. */
  hostUserId: text("host_user_id").references(() => users.discordId, {
    onDelete: "set null",
  }),
  /**
   * How many seats. Nullable on purpose.
   *
   * A `single` day takes its count from `games.max_players`; this column is the
   * override for the evening the table only has five chairs. On a `multi` day it
   * is the venue's cap, or nothing at all.
   */
  capacity: integer("capacity"),
  /** What is being played. Required on a `single` day — see `singleNamesGame`. */
  gameId: text("game_id").references(() => games.id, { onDelete: "set null" }),
  /**
   * How many people were queued when the table settled. Written once, by the
   * LOCK transition, and never again.
   *
   * It is a record rather than a derivation because the queue does not stand
   * still: a promotion during seating is exactly the thing that erases the fact
   * that there *was* a queue, and `withdraw` has no day-state guard, so a click
   * on a locked day's post can shorten it afterwards. A statistic read off the
   * live table would report the depth of whatever is left, which is a different
   * number wearing this one's name.
   *
   * Null on a day that has not locked. That is "not yet", never "nobody queued".
   */
  waitlistAtLock: integer("waitlist_at_lock"),

  /** The three ids a day accumulates. Recorded, then never read back from. */
  discordChannelId: text("discord_channel_id"),
  discordMessageId: text("discord_message_id"),
  threadId: text("thread_id"),

  createdAt: integer("created_at").notNull().default(now),
  updatedAt: integer("updated_at").notNull().default(now),
});

/**
 * A `single` day names a game.
 *
 * This is a CHECK in every sense except the one that would make it a CHECK.
 * SQLite cannot add a constraint to a table in place, so drizzle-kit would
 * answer with a rebuild — `__new_game_days`, copy, drop, rename — and
 * `docs/GOTCHAS.md` records what that costs on D1: the platform ignores
 * `PRAGMA foreign_keys=OFF`, so dropping the old table fires
 * `poll_dates.game_day_id`'s ON DELETE SET NULL and every link phase 4 wrote
 * from a winning date to the day it minted is silently blanked.
 *
 * Phase 2 hit this with `campaigns_interval_ck` and answered it the same way:
 * the rule moves to the one place that writes the row. A constraint that
 * destroys the data it is protecting is not a constraint worth having.
 */
export function singleNamesGame(day: { kind: string; gameId: string | null }): boolean {
  return day.kind !== "single" || day.gameId !== null;
}

/**
 * Asking a group which day works.
 *
 * One poll, its candidate dates, and one row per person per date they said yes
 * to. A poll either targets a session that already exists and needs moving
 * (#36), or targets nothing and is looking for a day to mint (#37) — which is
 * what `target_session_id` being nullable means.
 *
 * **At most one open poll per session**, and the partial unique index below is
 * that rule written where it cannot be raced. Two `/reschedule` calls a second
 * apart would otherwise open two polls on the same session, each with a live
 * select, and nothing later in the phase could tell which one counted.
 *
 * There is deliberately **no `auto_resolve` column here**. #38 specifies that
 * flag as `campaigns.auto_resolve_polls`, and a poll-level copy would have to be
 * written by an opening path that does not exist for another nine PRs. The
 * auto-resolve slice reads the campaign's flag live, through `campaign_id`.
 */
export const datePolls = sqliteTable(
  "date_polls",
  {
    id: text("id").primaryKey(),
    /**
     * The session this poll is trying to move, or null for a poll that is
     * looking for a day rather than moving one.
     */
    targetSessionId: text("target_session_id").references(() => sessions.id, {
      onDelete: "cascade",
    }),
    /** Whose roster the quorum rule counts, and whose auto-resolve flag applies. */
    campaignId: text("campaign_id").references(() => campaigns.id, { onDelete: "cascade" }),
    /** What would be played on the day this poll is looking for. */
    gameId: text("game_id").references(() => games.id, { onDelete: "set null" }),
    gameDayKind: text("game_day_kind", { enum: ["single", "multi"] }),
    /** What "winning" means for this poll. The rule itself is `src/polls/win-rule.ts`. */
    winRule: text("win_rule", {
      enum: ["min_players", "quorum_of_roster", "best_available", "organiser_picks"],
    })
      .notNull()
      .default("best_available"),
    /** The number `min_players` compares against, or the fraction `quorum_of_roster` does. */
    winThreshold: integer("win_threshold"),
    status: text("status", { enum: ["open", "closed"] })
      .notNull()
      .default("open"),
    openedBy: text("opened_by").references(() => users.discordId, { onDelete: "set null" }),
    /** When answering stops. Canonising does not — closing the answers is not closing the poll. */
    closesAt: integer("closes_at"),
    /** Recorded when the post goes up, then abandoned. Orrey never goes back to it. */
    discordChannelId: text("discord_channel_id"),
    discordMessageId: text("discord_message_id"),
    createdAt: integer("created_at").notNull().default(now),
    updatedAt: integer("updated_at").notNull().default(now),
  },
  (t) => [
    /**
     * One open poll per session. The index skips nulls, so any number of
     * untargeted polls can be open at once — which is the point: those are not
     * competing over anything.
     */
    uniqueIndex("date_polls_one_open_per_session")
      .on(t.targetSessionId)
      .where(sql`status = 'open' AND target_session_id IS NOT NULL`),
    index("date_polls_campaign_idx").on(t.campaignId, t.status),
  ],
);

/**
 * One candidate date. `outcome` is written once, when the poll is canonised:
 * every date ends `won` or `lost` and none is left `open`, because a poll that
 * closed without saying so about a date is a poll nobody can read afterwards.
 *
 * `withdrawn` exists because #34 names it. Nothing in phase 4 writes it.
 */
export const pollDates = sqliteTable(
  "poll_dates",
  {
    id: text("id").primaryKey(),
    pollId: text("poll_id")
      .notNull()
      .references(() => datePolls.id, { onDelete: "cascade" }),
    startsAt: integer("starts_at").notNull(),
    endsAt: integer("ends_at").notNull(),
    outcome: text("outcome", { enum: ["open", "won", "lost", "withdrawn"] })
      .notNull()
      .default("open"),
    /**
     * What this date became, once it won. Null for every date that did not, and
     * null again if the day is deleted — the poll is still a true record of what
     * people said, and losing that because a day was called off would be losing
     * the only account of how the date was chosen.
     */
    gameDayId: text("game_day_id").references(() => gameDays.id, { onDelete: "set null" }),
    createdAt: integer("created_at").notNull().default(now),
  },
  (t) => [
    index("poll_dates_poll_idx").on(t.pollId, t.startsAt),
    check("poll_dates_order_ck", sql`ends_at > starts_at`),
  ],
);

/**
 * "Yes, that one works." One row per person per date, and **only** yeses: a
 * person who has answered and chosen nothing has no rows at all, which is a real
 * answer and not an absence of one. The renderer knows the difference by asking
 * the roster, the same way the attendance post does.
 *
 * An answer is replaced whole rather than toggled, because Discord sends the
 * complete selection every time.
 */
export const pollResponses = sqliteTable(
  "poll_responses",
  {
    pollDateId: text("poll_date_id")
      .notNull()
      .references(() => pollDates.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.discordId, { onDelete: "cascade" }),
    available: integer("available").notNull().default(1),
    respondedAt: integer("responded_at").notNull().default(now),
  },
  (t) => [primaryKey({ columns: [t.pollDateId, t.userId] })],
);
