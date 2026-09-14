import { and, eq, sql } from "drizzle-orm";
import type { Env } from "../env.ts";
import { db, schema } from "../db/index.ts";

/**
 * `FORMING → RUNNING ⇄ HIATUS → CONCLUDED`, and nothing else.
 *
 * One function, one edge map, and an `audit_log` row written in the same batch
 * as the state change — so there is no way to move a campaign without leaving
 * the record of who moved it. The console calls this; so does anything else that
 * ever needs to. It is the only place `campaigns.state` is written.
 *
 * Two absences in the map are the enforcement, not oversights:
 *
 * - **RUNNING → FORMING is missing.** Starting a campaign closes its roster, and
 *   a closed roster never reopens on its own. Re-opening one is a decision
 *   somebody makes about a *new* campaign, not a state this one slips back into.
 * - **CONCLUDED has no outgoing edges.** It is terminal. A campaign that comes
 *   back is a new campaign with its own numbering, which is the honest thing for
 *   `first_session_number` to describe.
 */
export type CampaignState = (typeof schema.campaigns.$inferSelect)["state"];

const EDGES: Record<CampaignState, readonly CampaignState[]> = {
  FORMING: ["RUNNING"],
  RUNNING: ["HIATUS", "CONCLUDED"],
  HIATUS: ["RUNNING", "CONCLUDED"],
  CONCLUDED: [],
};

export class IllegalTransition extends Error {
  readonly from: CampaignState;
  readonly to: CampaignState;

  constructor(campaignId: string, from: CampaignState, to: CampaignState) {
    super(`campaign ${campaignId} cannot go ${from} → ${to}`);
    this.name = "IllegalTransition";
    this.from = from;
    this.to = to;
  }
}

export interface TransitionResult {
  from: CampaignState;
  to: CampaignState;
  /** False when the campaign was already there: nothing written, nothing logged. */
  changed: boolean;
  /** Signups turned into roster members by this transition. */
  membersAdded: number;
}

/**
 * `actor` is the Discord id of whoever asked, or null for the clock. Null is not
 * a fallback for "we did not bother to find out" — it is the honest answer when
 * the materialiser or a reminder acts, because they act on nobody's behalf.
 */
export async function transition(
  env: Env,
  campaignId: string,
  to: CampaignState,
  actor: string | null = null,
): Promise<TransitionResult> {
  const d = db(env);
  const campaign = await d
    .select()
    .from(schema.campaigns)
    .where(eq(schema.campaigns.id, campaignId))
    .get();

  if (!campaign) throw new Error(`no campaign ${campaignId}`);
  const from = campaign.state;

  // Already there. A double-click is not an error, and it is not history either:
  // an audit row saying RUNNING → RUNNING is noise in the one log that has to
  // stay readable.
  if (from === to) return { from, to, changed: false, membersAdded: 0 };

  if (!EDGES[from].includes(to)) throw new IllegalTransition(campaignId, from, to);

  // Read outside the batch, write inside it. The conversion is expressible as an
  // INSERT … SELECT, but not through this query builder, and the thing that has
  // to be atomic is the write: a roster half-converted by a crash is worse than
  // one read a moment before it was written.
  const joining = to === "RUNNING" && from === "FORMING" ? await accepted(env, campaignId) : [];

  const moved = d
    .update(schema.campaigns)
    .set({ state: to, updatedAt: sql`(unixepoch())` })
    .where(eq(schema.campaigns.id, campaignId));

  const logged = d.insert(schema.auditLog).values({
    id: crypto.randomUUID(),
    actorUserId: actor,
    action: "campaign.transition",
    targetType: "campaign",
    targetId: campaignId,
    detail: { before: from, after: to, membersAdded: joining.length },
  });

  if (joining.length === 0) {
    await d.batch([moved, logged]);
  } else {
    const enrolled = d
      .insert(schema.campaignMembers)
      .values(
        joining.map((signup) => ({
          campaignId,
          userId: signup.userId,
          role: "player" as const,
          characterName: signup.characterName,
        })),
      )
      // Somebody already on the roster stays as they are — including a GM put
      // there by hand before the campaign started.
      .onConflictDoNothing();

    await d.batch([moved, enrolled, logged]);
  }

  return { from, to, changed: true, membersAdded: joining.length };
}

/**
 * The people who claimed a place while the campaign was forming and did not
 * withdraw. `waitlisted` is not accepted: a waitlist is a queue, and starting the
 * campaign is not the same as letting the queue in.
 */
function accepted(env: Env, campaignId: string) {
  return db(env)
    .select({
      userId: schema.signups.userId,
      characterName: schema.signups.characterName,
    })
    .from(schema.signups)
    .where(
      and(
        eq(schema.signups.targetType, "campaign_forming"),
        eq(schema.signups.targetId, campaignId),
        eq(schema.signups.state, "in"),
      ),
    )
    .all();
}

/** Whether a campaign is still taking signups. Only FORMING ever is. */
export function isForming(campaign: { state: CampaignState }): boolean {
  return campaign.state === "FORMING";
}
