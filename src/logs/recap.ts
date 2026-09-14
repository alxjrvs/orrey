import type { Env } from "../env.ts";
import { isGm } from "../campaigns/roster.ts";
import { dayOfSession } from "../attendance/tables.ts";
import { escapeMarkdown } from "../discord/markdown.ts";
import { postToSession } from "../attendance/thread.ts";
import { loadProjectionTarget, sessionTitle } from "../projection/target.ts";
import { addSessionLog } from "./session-log.ts";

/**
 * Writing a recap: the whole of what one is, with one caller today.
 *
 * #46 names two doors into this — the modal on the correction post, and the
 * console form — and a shared function with one caller is a smaller review than
 * the same code written inside `handleModal` and lifted out a PR later. The
 * reviewer of the second door would then have to read a move and a feature at
 * once.
 *
 * It stores first and posts second, and that order is the point. The row is the
 * record; the message is the announcement. A post that went up without a row
 * behind it would be a recap nobody can find again, and the whole reason
 * `session_logs` exists is that Discord messages are not a database.
 */
export type RecapOutcome =
  | { outcome: "written"; body: string }
  | { outcome: "nothing-written" }
  | { outcome: "no-session" }
  | { outcome: "not-yours" }
  | { outcome: "nobody-running-it" };

export async function writeRecap(
  env: Env,
  entry: { sessionId: string; authorId: string; body: string },
): Promise<RecapOutcome> {
  const target = await loadProjectionTarget(env, entry.sessionId);
  if (!target) return { outcome: "no-session" };

  const may = await mayRecap(env, target.session.campaignId, entry.sessionId, entry.authorId);
  if (may !== "yes") return may === "no-host" ? { outcome: "nobody-running-it" } : { outcome: "not-yours" };

  const log = await addSessionLog(env, entry);
  // An empty box is not an error and is not an empty row. A recap is appended,
  // never replaced, so there is no "clear it" to express and nothing to say.
  if (!log) return { outcome: "nothing-written" };

  // A **new message**, never a rewrite of the correction post. The post has
  // toggles on it that everybody else is still using, and a recap is a message
  // of its own — which is also why the body keeps the newlines a note would
  // lose.
  await postToSession(env, target, {
    content: [
      `**Recap** — ${escapeMarkdown(sessionTitle(target))}`,
      "",
      escapeMarkdown(log.body),
    ].join("\n"),
    components: [],
    allowed_mentions: { parse: [], roles: [] },
  });

  return { outcome: "written", body: log.body };
}

/**
 * Who may write one.
 *
 * A campaign session's is its GM's, read off `campaign_members`. A game day has
 * no GM, so it is whoever is down as running the day — the same question
 * `tablesPlayed` asks, and the same answer, because it is the same person.
 */
export async function mayRecap(
  env: Env,
  campaignId: string | null,
  sessionId: string,
  userId: string,
): Promise<"yes" | "no" | "no-host"> {
  if (campaignId) return (await isGm(env, campaignId, userId)) ? "yes" : "no";

  const day = await dayOfSession(env, sessionId);
  if (!day) return "no";
  if (!day.hostUserId) return "no-host";
  return day.hostUserId === userId ? "yes" : "no";
}
