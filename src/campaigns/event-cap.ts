import { and, asc, eq, gte, isNotNull } from "drizzle-orm";
import type { Env } from "../env.ts";
import { db, schema } from "../db/index.ts";
import { enqueueProjection, enqueueUnprojection, type ProjectionSurface } from "../projection/outbox.ts";

/**
 * Discord's horizon is two upcoming events per campaign. D1 and Google run as
 * far ahead as `horizon.sessions` says.
 *
 * The reason is a platform limit and a design decision that agree with each
 * other. Discord allows a hundred scheduled events per guild, and Orrey treats
 * them as disposable — a session whose event has lapsed needs a *new* event,
 * because COMPLETED and CANCELED are terminal and fire on their own. Four
 * campaigns times two is eight against a cap of a hundred, and the headroom is
 * deliberate: phase 4 mints a replacement every time a lapsed session moves.
 *
 * Google has no such limit and no such disposability, so there is no reason to
 * keep the calendar short. Somebody subscribing to the Orrey calendar wants to
 * see October.
 */
export const DISCORD_EVENT_HORIZON = 2;

/**
 * Which surfaces this session should be published to. Google always; Discord
 * only while the session is one of its campaign's next two.
 *
 * A one-off has no campaign to be third in, so it always gets both.
 */
export async function surfacesFor(
  env: Env,
  sessionId: string,
  now: Date,
): Promise<ProjectionSurface[]> {
  const session = await db(env)
    .select({ campaignId: schema.sessions.campaignId })
    .from(schema.sessions)
    .where(eq(schema.sessions.id, sessionId))
    .get();

  if (!session?.campaignId) return ["discord", "google"];

  const nearest = await upcoming(env, session.campaignId, now, DISCORD_EVENT_HORIZON);
  return nearest.some((row) => row.id === sessionId) ? ["discord", "google"] : ["google"];
}

/**
 * Roll the Discord horizon forward. Runs after materialising, for every running
 * campaign rather than only the ones that gained a session — the cap moves when
 * a session *passes*, not only when one is made.
 *
 * It asks for the minimum: an event for a session inside the cap that has none,
 * and a retraction for one outside it that still has one. Everything else is
 * already where it should be, and re-enqueuing it would spend a rate-limit slot
 * to write what is already written.
 */
export async function enforceEventCap(env: Env, campaignId: string, now: Date): Promise<void> {
  const nearest = await upcoming(env, campaignId, now, DISCORD_EVENT_HORIZON);
  const inside = new Set(nearest.map((row) => row.id));

  for (const row of nearest) {
    if (!row.discordEventId) await enqueueProjection(env, row.id, ["discord"]);
  }

  // Anything still holding an event that is no longer one of the next two. Past
  // sessions are deliberately not swept: the cap counts upcoming, and an event
  // for a session that has already happened is a record of it, not clutter.
  const overflow = await db(env)
    .select({ id: schema.sessions.id })
    .from(schema.sessions)
    .where(
      and(
        eq(schema.sessions.campaignId, campaignId),
        gte(schema.sessions.startsAt, Math.floor(now.getTime() / 1000)),
        isNotNull(schema.sessions.discordEventId),
      ),
    )
    .all();

  for (const row of overflow) {
    if (!inside.has(row.id)) await enqueueUnprojection(env, row.id, ["discord"]);
  }
}

function upcoming(env: Env, campaignId: string, now: Date, limit: number) {
  return db(env)
    .select({ id: schema.sessions.id, discordEventId: schema.sessions.discordEventId })
    .from(schema.sessions)
    .where(
      and(
        eq(schema.sessions.campaignId, campaignId),
        gte(schema.sessions.startsAt, Math.floor(now.getTime() / 1000)),
      ),
    )
    .orderBy(asc(schema.sessions.startsAt))
    .limit(limit)
    .all();
}
