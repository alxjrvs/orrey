import { and, asc, desc, eq, lt, or, sql } from "drizzle-orm";
import type { Env } from "../env.ts";
import { db, schema } from "../db/index.ts";

/**
 * Who changed what.
 *
 * Read-only, newest first, and **keyset-paginated on `(created_at, id)`** rather
 * than by offset. An audit log grows at the head: `LIMIT 20 OFFSET 20` re-reads
 * rows it has already shown the moment anybody writes while you are reading, so
 * an offset pager on this table skips and repeats entries under exactly the
 * conditions people open it in.
 *
 * The whole view is organiser-gated on the route. Nothing here re-decides that
 * per row — a gate asked once is a gate; a gate asked per row is a filter, and a
 * filter with a bug shows one row too many.
 */
export interface AuditRow {
  id: string;
  /** Null is the clock: the materialiser and the reminders act on nobody's behalf. */
  actorUserId: string | null;
  actorName: string | null;
  action: string;
  targetType: string;
  targetId: string;
  detail: unknown;
  createdAt: number;
}

export interface AuditPage {
  rows: AuditRow[];
  /**
   * Where the next page starts, or null at the end. Opaque to the browser: it is
   * the last row's `(created_at, id)` and nothing else is allowed to depend on
   * that shape.
   */
  cursor: string | null;
}

export interface AuditQuery {
  actorUserId?: string | undefined;
  targetType?: string | undefined;
  targetId?: string | undefined;
  cursor?: string | undefined;
  limit?: number | undefined;
}

const PAGE = 50;

export async function auditPage(env: Env, query: AuditQuery = {}): Promise<AuditPage> {
  const limit = Math.min(Math.max(query.limit ?? PAGE, 1), 200);
  const after = decode(query.cursor);

  const where = [
    ...(query.actorUserId ? [eq(schema.auditLog.actorUserId, query.actorUserId)] : []),
    ...(query.targetType ? [eq(schema.auditLog.targetType, query.targetType)] : []),
    ...(query.targetId ? [eq(schema.auditLog.targetId, query.targetId)] : []),
    // Strictly *after* the last row in the reading order, which for a descending
    // order is "older than". The tie-break on id is what makes two rows written
    // in the same second pageable at all.
    ...(after
      ? [
          or(
            lt(schema.auditLog.createdAt, after.createdAt),
            and(eq(schema.auditLog.createdAt, after.createdAt), lt(schema.auditLog.id, after.id)),
          ) as ReturnType<typeof eq>,
        ]
      : []),
  ];

  const rows = await db(env)
    .select({
      row: schema.auditLog,
      username: schema.users.username,
      globalName: schema.users.globalName,
    })
    .from(schema.auditLog)
    .leftJoin(schema.users, eq(schema.auditLog.actorUserId, schema.users.discordId))
    .where(where.length > 0 ? and(...where) : undefined)
    .orderBy(desc(schema.auditLog.createdAt), desc(schema.auditLog.id))
    // One more than asked for, so "is there another page" is known rather than
    // guessed from a full page.
    .limit(limit + 1)
    .all();

  const page = rows.slice(0, limit);
  const last = page[page.length - 1];

  return {
    rows: page.map(({ row, username, globalName }) => ({
      id: row.id,
      actorUserId: row.actorUserId,
      actorName: row.actorUserId ? (globalName ?? username ?? null) : null,
      action: row.action,
      targetType: row.targetType,
      targetId: row.targetId,
      detail: row.detail,
      createdAt: row.createdAt,
    })),
    cursor: rows.length > limit && last ? encode(last.row.createdAt, last.row.id) : null,
  };
}

/**
 * One line, in the register `design/readme.md` sets out for the log and for
 * nothing else: lower case, no full stop, 24h times, arrows for transitions.
 *
 *     18:51 alx → campaign age-of-umbra state running → hiatus
 *
 * Deliberately unlike every other surface in the console. This is the one screen
 * allowed to be curt, and a pure function of a row so it can be tested as one.
 */
export function auditLine(row: AuditRow, timeZone = "UTC"): string {
  const time = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(row.createdAt * 1000));

  const who = row.actorName ?? row.actorUserId ?? "orrey";
  const parts = [time, who, "→", row.targetType, row.targetId, verb(row.action)];

  const change = transition(row.detail);
  // No arrow when there is nothing on the left of it. A creation has no previous
  // value, and "→ hiatus" with an empty space in front reads as a missing word
  // rather than as an absence.
  if (change) parts.push(change.before === null ? change.after : `${change.before} → ${change.after}`);

  return parts.filter(Boolean).join(" ");
}

/** `campaign.start` reads as `start`; the target already said it was a campaign. */
function verb(action: string): string {
  const dot = action.indexOf(".");
  return dot === -1 ? action : action.slice(dot + 1);
}

function transition(detail: unknown): { before: string | null; after: string } | null {
  if (!detail || typeof detail !== "object") return null;
  const record = detail as Record<string, unknown>;
  if (!("after" in record)) return null;

  const after = scalar(record.after);
  if (after === null) return null;
  return { before: scalar(record.before), after };
}

function scalar(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value).toLowerCase();
  }
  // An object before/after is a whole row, not a transition. The line says the
  // action happened and leaves the diff to whoever opens the row.
  return null;
}

function encode(createdAt: number, id: string): string {
  return `${createdAt}.${id}`;
}

function decode(cursor: string | undefined): { createdAt: number; id: string } | undefined {
  if (!cursor) return undefined;
  const dot = cursor.indexOf(".");
  if (dot <= 0) return undefined;
  const createdAt = Number(cursor.slice(0, dot));
  if (!Number.isInteger(createdAt)) return undefined;
  return { createdAt, id: cursor.slice(dot + 1) };
}

/** Everybody who has ever appeared in the log, for the actor filter. */
export async function auditActors(env: Env): Promise<{ userId: string; name: string }[]> {
  const rows = await db(env)
    .selectDistinct({
      userId: schema.auditLog.actorUserId,
      username: schema.users.username,
      globalName: schema.users.globalName,
    })
    .from(schema.auditLog)
    .leftJoin(schema.users, eq(schema.auditLog.actorUserId, schema.users.discordId))
    .orderBy(asc(schema.auditLog.actorUserId))
    .all();

  return rows
    .filter((row): row is typeof row & { userId: string } => row.userId !== null)
    .map((row) => ({ userId: row.userId, name: row.globalName ?? row.username ?? row.userId }));
}

/** Exported so the route can count without paging. */
export function auditCount(env: Env): Promise<number> {
  return db(env)
    .select({ n: sql<number>`count(*)` })
    .from(schema.auditLog)
    .get()
    .then((row) => row?.n ?? 0);
}
