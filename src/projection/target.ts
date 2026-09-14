import { eq } from "drizzle-orm";
import type { Env } from "../env.ts";
import { db, schema } from "../db/index.ts";
import { fingerprint } from "./fingerprint.ts";

/**
 * What a projector needs to know: the session, and whichever parent it hangs
 * off. Loaded from D1 every time a queue message is handled — never carried in
 * the message, which holds nothing but an id. The database is the source of
 * truth, so a message that has been sitting in the queue for a minute must not
 * project what was true when it was produced.
 *
 * A session has exactly one parent — `hasExactlyOneParent` in the schema is the
 * rule, and `p5/2` says why it is there rather than in a CHECK. So exactly one
 * of `campaign` and `gameDay` is set on a target loaded from a well-formed row,
 * and every function below asks which one rather than testing for absence.
 */
export interface ProjectionTarget {
  session: typeof schema.sessions.$inferSelect;
  campaign: typeof schema.campaigns.$inferSelect | null;
  gameDay: typeof schema.gameDays.$inferSelect | null;
  /**
   * What a `single` game day is playing, when it names one. Campaigns carry a
   * game of their own and no projector has ever read it, so this join is the
   * day's alone and there is nothing ambiguous about it.
   */
  game: typeof schema.games.$inferSelect | null;
}

export async function loadProjectionTarget(
  env: Env,
  sessionId: string,
): Promise<ProjectionTarget | undefined> {
  const row = await db(env)
    .select({
      session: schema.sessions,
      campaign: schema.campaigns,
      gameDay: schema.gameDays,
      game: schema.games,
    })
    .from(schema.sessions)
    .leftJoin(schema.campaigns, eq(schema.sessions.campaignId, schema.campaigns.id))
    .leftJoin(schema.gameDays, eq(schema.sessions.gameDayId, schema.gameDays.id))
    .leftJoin(schema.games, eq(schema.gameDays.gameId, schema.games.id))
    .where(eq(schema.sessions.id, sessionId))
    .get();

  return row
    ? { session: row.session, campaign: row.campaign, gameDay: row.gameDay, game: row.game }
    : undefined;
}

/**
 * A target for a row already known to be a campaign session.
 *
 * `/upcoming` and `/whos-in` both reach sessions through `campaign_members`, so
 * their joins cannot produce anything but a campaign's. This exists so those
 * call sites say that, instead of each writing two nulls whose meaning a reader
 * has to reconstruct.
 */
export function campaignTarget(
  session: ProjectionTarget["session"],
  campaign: ProjectionTarget["campaign"],
): ProjectionTarget {
  return { session, campaign, gameDay: null, game: null };
}

/** `Age of Umbra — Session 12`, and what the other kinds have instead. */
export function sessionTitle(target: ProjectionTarget): string {
  const { session, campaign, gameDay, game } = target;
  if (campaign) {
    return session.number == null ? campaign.name : `${campaign.name} — Session ${session.number}`;
  }
  if (gameDay) return gameDayTitle(gameDay, game);
  // A one-off with no parent at all. `hasExactlyOneParent` says there should be
  // none, but phase 1's CHECK still permits one and this is not the place to
  // discover that: a title is not worth throwing over.
  return session.location ? `Session — ${session.location}` : "Session";
}

/**
 * A `single` day is named after what it is playing, because that is what people
 * are deciding whether to come to. A `multi` day has no one game, so it is named
 * after itself — `title` is what phase 4 wrote when the poll won, and what an
 * organiser edits afterwards.
 */
export function gameDayTitle(
  day: typeof schema.gameDays.$inferSelect,
  game: typeof schema.games.$inferSelect | null,
): string {
  if (day.kind === "single") return game?.name ?? day.title ?? "Game day";
  return day.title ?? "Game day";
}

/**
 * Where it is. A campaign session carries its own location; a game day's is the
 * venue, which lives on the day because every session of that day shares it.
 *
 * Both fingerprints read this, so moving the venue moves the Discord event and
 * the Google event together, and neither projector gains a branch to do it.
 */
export function locationOf({ session, gameDay }: ProjectionTarget): string | null {
  return session.location ?? gameDay?.venue ?? null;
}

/**
 * A fingerprint per surface, over exactly what that surface renders — because
 * the whole point of a fingerprint is to skip a write that would change
 * nothing. A shared one made moving the voice channel rewrite the *Google*
 * event, moving its `updated` for a field Google never showed, which is the
 * one thing phase 7's return path must not have to explain.
 */
export function discordProjectedContent(target: ProjectionTarget) {
  const { session, campaign } = target;
  return {
    ...googleProjectedContent(target),
    /**
     * The event's description carries `orrey:session:<id>`, which is how an
     * event Orrey already made is recognised when every record of its id has
     * been lost (#73). It is in the fingerprint because it is in the body: the
     * fingerprint covers exactly what the remote object shows, and leaving it
     * out would mean every event that predates the marker keeps a matching
     * fingerprint, never gets rewritten, and stays unrecognisable forever.
     *
     * Constant per session, so this moves each live event's fingerprint exactly
     * once — one PATCH each, on the first upsert after this lands.
     */
    sessionId: session.id,
    // Decides EXTERNAL vs VOICE, and which of the two fields the event carries.
    locationType: campaign?.locationType ?? "external",
    voiceChannelId: campaign?.discordVoiceChannelId ?? null,
  };
}

export function googleProjectedContent(target: ProjectionTarget) {
  const { session } = target;
  return {
    title: sessionTitle(target),
    startsAt: session.startsAt,
    endsAt: session.endsAt,
    location: locationOf(target),
    state: session.state,
  };
}

export function discordFingerprint(target: ProjectionTarget): Promise<string> {
  return fingerprint(discordProjectedContent(target));
}

export function googleFingerprint(target: ProjectionTarget): Promise<string> {
  return fingerprint(googleProjectedContent(target));
}

/**
 * Whether Orrey should be publishing this outward at all.
 *
 * A campaign that is not running has nothing to publish — a concluded
 * campaign's old sessions must not reappear on a calendar because a queue
 * message was redelivered.
 *
 * This used to read "a session with no campaign is always projectable", which
 * was true in phase 1 for the reason that nobody had a one-off. Phase 5 gives
 * one-offs a parent, so the question stops being "is there a campaign" and
 * becomes "what does whichever parent this has say" — and a session with no
 * parent at all, which `hasExactlyOneParent` forbids, publishes nothing.
 *
 * It fails closed in both directions: a day is published only in the three
 * states where it is a real, seated, public thing, and every state that is not
 * on that list — `PROPOSED`, `CANCELLED`, and anything a later phase adds —
 * answers no.
 */
const DAY_PUBLISHES = new Set(["SEATING", "LOCKED", "PLAYED"]);

export function isProjectable({ campaign, gameDay }: ProjectionTarget): boolean {
  if (campaign) return campaign.state === "RUNNING";
  if (gameDay) return DAY_PUBLISHES.has(gameDay.state);
  return false;
}
