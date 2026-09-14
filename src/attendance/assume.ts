import { and, eq, sql } from "drizzle-orm";
import type { Env } from "../env.ts";
import { db, schema } from "../db/index.ts";
import { attendanceRows } from "./rows.ts";
import type { ProjectionTarget } from "../projection/target.ts";

/**
 * When the session ends, write down what happened — by assuming it was what
 * people said.
 *
 * Nobody ticks a register at a table. So Orrey assumes from intent, marks the
 * assumption as an assumption (`attended_source = 'auto'`), and gives the
 * organiser a post to correct it on. The numbers matter because flake memory and
 * stats read them, and a register nobody fills in is a register full of nulls.
 *
 * `maybe` is the interesting one. #31 calls it the organiser's call and defaults
 * it to 0, which is the right default for exactly one reason: an assumption that
 * somebody *did* turn up is invisible when it is wrong, and an assumption they
 * did not is a toggle the organiser can see and flip.
 */
export const ASSUME_JOB = "attendance.assume";

export async function armAssume(env: Env, sessionId: string, endsAt: number): Promise<void> {
  const id = `${ASSUME_JOB}:${sessionId}`;
  await db(env)
    .insert(schema.jobs)
    .values({ id, kind: ASSUME_JOB, payload: { sessionId }, idempotencyKey: id, runAt: endsAt })
    .onConflictDoUpdate({
      target: schema.jobs.id,
      set: { runAt: endsAt, state: "pending", attempts: 0, lastError: null },
    });
}

/** What was assumed, so the correction post can render it without asking again. */
export interface Assumed {
  userId: string;
  name: string;
  attended: boolean;
}

export function attendedFrom(intent: "in" | "out" | "maybe" | null): boolean {
  return intent === "in";
}

export async function assumeAttendance(
  env: Env,
  target: ProjectionTarget,
): Promise<Assumed[]> {
  const { session } = target;

  // A session that was called off did not happen, and one already marked played
  // has been through this. Neither wants its register rewritten.
  if (session.state === "CANCELLED" || session.state === "PLAYED") return [];

  const rows = await attendanceRows(env, session.id);
  const assumed: Assumed[] = rows.map((row) => ({
    userId: row.userId,
    name: row.name,
    attended: attendedFrom(row.intent),
  }));

  const d = db(env);
  const writes = assumed.map((row) =>
    d
      .insert(schema.attendance)
      .values({
        sessionId: session.id,
        userId: row.userId,
        attended: row.attended ? 1 : 0,
        attendedSource: "auto",
      })
      .onConflictDoUpdate({
        target: [schema.attendance.sessionId, schema.attendance.userId],
        // Only where nobody has already said otherwise. An organiser who
        // corrected the register before the job ran — or after a re-run — must
        // not have their answer replaced by an assumption.
        set: { attended: row.attended ? 1 : 0, attendedSource: "auto" },
        setWhere: sql`${schema.attendance.attendedSource} IS NULL
          OR ${schema.attendance.attendedSource} = 'auto'`,
      }),
  );

  const played = d
    .update(schema.sessions)
    .set({ state: "PLAYED", updatedAt: sql`(unixepoch())` })
    .where(eq(schema.sessions.id, session.id));

  // One batch: a session marked PLAYED with half a register written is worse than
  // one not marked at all, because the second gets retried and the first does
  // not. `played` leads so the tuple is non-empty whatever the roster holds.
  await d.batch([played, ...writes]);

  return assumed;
}

/** What the register says now, for the correction post above this. */
export function registerOf(env: Env, sessionId: string) {
  return db(env)
    .select({
      userId: schema.attendance.userId,
      attended: schema.attendance.attended,
      attendedSource: schema.attendance.attendedSource,
      intent: schema.attendance.intent,
      username: schema.users.username,
      globalName: schema.users.globalName,
    })
    .from(schema.attendance)
    .leftJoin(schema.users, eq(schema.attendance.userId, schema.users.discordId))
    .where(and(eq(schema.attendance.sessionId, sessionId)))
    .all();
}

/** The register as the correction post shows it. */
export async function registerRows(env: Env, sessionId: string) {
  const rows = await registerOf(env, sessionId);
  return rows.map((row) => ({
    userId: row.userId,
    name: row.globalName ?? row.username ?? `<@${row.userId}>`,
    attended: row.attended === 1,
    corrected: row.attendedSource === "gm",
  }));
}
