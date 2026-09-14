import { asc, eq, inArray } from "drizzle-orm";
import type { Env } from "../env.ts";
import { db, schema } from "../db/index.ts";
import { SESSION_CONFIRMED, SESSION_MOVED } from "../db/audit.ts";

/**
 * What the audit trail says about a campaign's scheduling.
 *
 * The other half of #47's first checkbox, and a different question from the
 * attendance half: not "what do the rows say" but "do these two audit kinds mean
 * what the statistic claims they mean". Hence a separate file and a separate
 * review.
 *
 * Both kinds come from `src/db/audit.ts` and are never re-spelled here. A reader
 * that matched on a string literal would silently stop counting the day the
 * writer's spelling changed — and a statistic that quietly stops counting is
 * worse than one that breaks, because the number stays plausible.
 */

export interface MoveRow {
  sessionId: string;
}

export interface ConfirmRow {
  sessionId: string;
  createdAt: number;
}

export interface SessionRow {
  sessionId: string;
  number: number | null;
  createdAt: number;
}

export interface MostRescheduled {
  sessionId: string;
  number: number | null;
  moves: number;
}

export interface ScheduleStats {
  /**
   * The session that moved most, or **null** when nothing has ever moved.
   * Null is "no answer yet", not "a session that moved zero times".
   */
  mostRescheduled: MostRescheduled | null;
  /**
   * Mean seconds between a session being created and confirming itself, over
   * the sessions that confirmed.
   *
   * **Null when none has.** A session that never reached quorum has no lead
   * time — not a lead time of nothing — so it is excluded from the average
   * rather than counted as zero, and the average of none is null.
   */
  averageLeadSeconds: number | null;
  /** How many sessions the average is over, so the page can say "of thirteen". */
  confirmed: number;
}

export function computeScheduleStats(input: {
  sessions: SessionRow[];
  moves: MoveRow[];
  confirms: ConfirmRow[];
}): ScheduleStats {
  const known = new Map(input.sessions.map((session) => [session.sessionId, session]));

  const counts = new Map<string, number>();
  for (const move of input.moves) {
    // A move of a session this campaign does not own is not this campaign's
    // statistic. The loader scopes its query, and this keeps that true of the
    // pure function too.
    if (!known.has(move.sessionId)) continue;
    counts.set(move.sessionId, (counts.get(move.sessionId) ?? 0) + 1);
  }

  let mostRescheduled: MostRescheduled | null = null;
  for (const [sessionId, moves] of counts) {
    const session = known.get(sessionId)!;
    // Ties go to the earlier session — `sessions` arrives in date order, so the
    // first one to reach a count keeps it. An arbitrary tie-break is still
    // better than one that changes between two reads of the same data.
    if (!mostRescheduled || moves > mostRescheduled.moves) {
      mostRescheduled = { sessionId, number: session.number, moves };
    }
  }

  // First confirmation only. A session cannot un-confirm, but a replayed batch
  // or a second crossing after a correction could write a second row, and the
  // lead time is to the first one.
  const firstConfirm = new Map<string, number>();
  for (const confirm of input.confirms) {
    if (!known.has(confirm.sessionId)) continue;
    const held = firstConfirm.get(confirm.sessionId);
    if (held === undefined || confirm.createdAt < held) {
      firstConfirm.set(confirm.sessionId, confirm.createdAt);
    }
  }

  const leads: number[] = [];
  for (const [sessionId, at] of firstConfirm) {
    const session = known.get(sessionId)!;
    // A confirmation stamped before the session row is a clock nobody can read
    // anything into. Clamped at zero rather than dragging the mean negative.
    leads.push(Math.max(0, at - session.createdAt));
  }

  return {
    mostRescheduled,
    averageLeadSeconds:
      leads.length === 0 ? null : leads.reduce((a, b) => a + b, 0) / leads.length,
    confirmed: leads.length,
  };
}

export async function loadScheduleStats(env: Env, campaignId: string): Promise<ScheduleStats> {
  const d = db(env);

  const sessions = await d
    .select({
      sessionId: schema.sessions.id,
      number: schema.sessions.number,
      createdAt: schema.sessions.createdAt,
    })
    .from(schema.sessions)
    .where(eq(schema.sessions.campaignId, campaignId))
    .orderBy(asc(schema.sessions.startsAt))
    .all();

  if (sessions.length === 0) {
    return { mostRescheduled: null, averageLeadSeconds: null, confirmed: 0 };
  }

  // Ninety ids a statement, inside D1's hundred-bound-parameter ceiling.
  const ids = sessions.map((session) => session.sessionId);
  const moves: MoveRow[] = [];
  const confirms: ConfirmRow[] = [];
  for (let from = 0; from < ids.length; from += 90) {
    const page = ids.slice(from, from + 90);
    const rows = await d
      .select({
        action: schema.auditLog.action,
        targetId: schema.auditLog.targetId,
        createdAt: schema.auditLog.createdAt,
      })
      .from(schema.auditLog)
      .where(inArray(schema.auditLog.targetId, page))
      .orderBy(asc(schema.auditLog.createdAt))
      .all();

    for (const row of rows) {
      if (row.action === SESSION_MOVED) moves.push({ sessionId: row.targetId });
      else if (row.action === SESSION_CONFIRMED) {
        confirms.push({ sessionId: row.targetId, createdAt: row.createdAt });
      }
    }
  }

  return computeScheduleStats({ sessions, moves, confirms });
}
