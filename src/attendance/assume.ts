import { and, eq, sql } from "drizzle-orm";
import type { Env } from "../env.ts";
import { db, schema } from "../db/index.ts";
import { rearm, type ArmedJob } from "../jobs/arm.ts";
import { attendanceRows } from "./rows.ts";
import { quorumOf, type RuleKind } from "./quorum.ts";
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

/**
 * The row, described. `transition` puts it in the same batch as the state write
 * that makes it necessary; everybody else writes it on its own.
 */
export function assumeJob(sessionId: string, endsAt: number): ArmedJob {
  return {
    id: `${ASSUME_JOB}:${sessionId}`,
    kind: ASSUME_JOB,
    payload: { sessionId },
    runAt: endsAt,
  };
}

export async function armAssume(env: Env, sessionId: string, endsAt: number): Promise<void> {
  await rearm(db(env), [assumeJob(sessionId, endsAt)]);
}

/** What was assumed, so the correction post can render it without asking again. */
export interface Assumed {
  userId: string;
  name: string;
  attended: boolean;
}

/**
 * What to write down about one person, given what they said and which rule the
 * session was running under.
 *
 * **Under a quorum, only an `in`.** Unchanged, and #31's reasoning holds: silence
 * there is a question nobody answered, `maybe` is somebody who would not commit,
 * and an assumption that they *did* turn up is invisible when it is wrong where an
 * assumption they did not is a toggle the organiser can see and flip.
 *
 * **Under the veto rule, anything but an `out`.** The same reasoning, applied to a
 * rule where silence means the opposite thing. The post told them in as many
 * words: *silence counts as in; press Out if you cannot make it.* Writing down
 * that everybody who took the post at its word was absent is not a cautious
 * assumption, it is the wrong one — and because nearly every roster is nearly
 * always silent, it is the wrong one about nearly everybody, on every session.
 * "Came to 0 of 12" is worse than no number, and it is what the old default would
 * have said about the three real campaigns for ever.
 *
 * `maybe` goes with silence here rather than with `out`, for the same reason it is
 * not a veto: it is not "cannot make it". Somebody who would not commit was still
 * counted in by the rule that held the evening together.
 *
 * Either way the row is marked `auto`, and either way the correction post is a
 * toggle per person. The question is only which way round the organiser has less
 * to correct.
 */
export function attendedFrom(
  intent: "in" | "out" | "maybe" | null,
  rule: RuleKind = "quorum",
): boolean {
  return rule === "unanimous" ? intent !== "out" : intent === "in";
}

export async function assumeAttendance(
  env: Env,
  target: ProjectionTarget,
): Promise<Assumed[]> {
  const { session } = target;

  // A session that was called off did not happen. There is nothing to assume and
  // nothing to correct.
  if (session.state === "CANCELLED") return [];

  /**
   * Already played, so the register has been written and must not be rewritten —
   * but **the answer is still the register**, not nothing.
   *
   * Returning `[]` here made the PLAYED write the thing that enforced "once".
   * The drain marks the session played inside this call and posts the correction
   * post afterwards; if that post was refused, the retry found PLAYED, got an
   * empty list, returned early, and the organiser was left with a register they
   * could never correct — assumed for everybody, with no post to flip anyone on.
   * The claim in `postNoticeOnce` is what makes the post once.
   */
  if (session.state === "PLAYED") return registerRows(env, session.id);

  const rows = await attendanceRows(env, session.id);
  // Which rule the evening ran under, asked of the one function that decides it.
  // The register is a statement about what the rule meant, so it cannot be written
  // without knowing which one was in force.
  const { rule } = quorumOf(target, rows);
  const assumed: Assumed[] = rows.map((row) => ({
    userId: row.userId,
    name: row.name,
    attended: attendedFrom(row.intent, rule),
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
      tablesPlayed: schema.attendance.tablesPlayed,
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
    tablesPlayed: row.tablesPlayed,
  }));
}
