import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * Phase 0 tables only — the footings.
 *
 * The domain proper (campaigns, sessions, signups, attendance, date_polls,
 * calendar_links, games, campaign_members, session_logs, audit_log) lands in
 * phases 1–4, as each one is actually used. See docs/build-plan.md.
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
