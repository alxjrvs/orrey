import { eq, sql } from "drizzle-orm";
import type { Env } from "../env.ts";
import { db, schema } from "../db/index.ts";
import { slugify } from "../db/seed-sql.ts";

/**
 * Creating and editing a campaign, with the audit row in the same batch as the
 * change.
 *
 * This is the domain function, not a route handler: the console calls it, and so
 * does anything else that ever needs to. #25's last bullet is that every write
 * goes through the same functions as the bot and lands in `audit_log`, and the
 * only way to keep that true is for there to be nowhere else to write from.
 *
 * `state` is deliberately not writable here. A campaign moves through its
 * lifecycle by `transition` and by nothing else — a form that could set it to
 * CONCLUDED would be a second way to do the one thing that is meant to have one.
 */
export interface CampaignInput {
  name: string;
  kind: "run" | "play" | "tracked";
  gameId?: string | null;
  discordChannelId?: string | null;
  discordRoleId?: string | null;
  discordVoiceChannelId?: string | null;
  colour?: number | null;
  locationType?: "external" | "voice";
  recurrenceAnchor?: number | null;
  intervalWeeks?: number | null;
  quorum?: number | null;
  capacity?: number | null;
  maxSessions?: number | null;
  firstSessionNumber?: number;
}

export class InvalidCampaign extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidCampaign";
  }
}

/**
 * The rules that could not live in a CHECK, because adding one to `campaigns`
 * means rebuilding a referenced table and in D1 that cascades its children away
 * (docs/GOTCHAS.md). They live here instead, in the code that writes the column,
 * which is where #77 said they would.
 */
const KINDS = ["run", "play", "tracked"] as const;

/**
 * `merged` is the row as it will be *after* this request, which is not the same
 * as the request. A PATCH sends only what changed, so checking a rule against
 * the body alone refuses `{intervalWeeks: 3}` on a campaign that already has an
 * anchor — a valid edit, rejected for a field it did not mention.
 */
export function validate(input: Partial<CampaignInput>, merged: Partial<CampaignInput> = input): void {
  if (input.name !== undefined && input.name.trim() === "") {
    throw new InvalidCampaign("a campaign needs a name");
  }
  if (input.kind !== undefined && !KINDS.includes(input.kind)) {
    throw new InvalidCampaign(`kind is run, play or tracked — not ${JSON.stringify(input.kind)}`);
  }
  if (input.intervalWeeks != null && input.intervalWeeks <= 0) {
    throw new InvalidCampaign(
      `interval_weeks must be positive, not ${input.intervalWeeks} — a cadence of zero never advances`,
    );
  }
  if (input.firstSessionNumber != null && input.firstSessionNumber < 0) {
    throw new InvalidCampaign("a campaign cannot start at a negative session number");
  }
  if (input.maxSessions != null && input.maxSessions <= 0) {
    throw new InvalidCampaign("a campaign with no sessions left to play is concluded, not capped");
  }
  // A cadence is both halves or neither: an anchor with no interval never
  // produces anything, and an interval with no anchor has nothing to count from.
  const anchor = merged.recurrenceAnchor;
  const interval = merged.intervalWeeks;
  if ((anchor == null) !== (interval == null)) {
    throw new InvalidCampaign("a cadence needs both an anchor and an interval, or neither");
  }
  // `== null` catches the absent case as well as the explicit null: asking for a
  // voice campaign and simply not mentioning a channel is the common way to get
  // this wrong, and it used to be accepted.
  if (merged.locationType === "voice" && merged.discordVoiceChannelId == null) {
    throw new InvalidCampaign("a voice campaign needs the voice channel id");
  }
}

export async function createCampaign(
  env: Env,
  input: CampaignInput,
  actor: string,
): Promise<string> {
  // Required on a create in a way they are not on an edit. Without this, a body
  // with no kind reached the NOT NULL constraint as a 500, and one with no name
  // reached `slugify(undefined)` — both of which are a bad request wearing a
  // fault's clothes.
  if (typeof input.name !== "string" || input.name.trim() === "") {
    throw new InvalidCampaign("a campaign needs a name");
  }
  if (input.kind === undefined) {
    throw new InvalidCampaign("a campaign needs a kind: run, play or tracked");
  }
  validate(input);

  const id = slugify(input.name);
  const existing = await db(env)
    .select({ id: schema.campaigns.id })
    .from(schema.campaigns)
    .where(eq(schema.campaigns.id, id))
    .get();
  if (existing) throw new InvalidCampaign(`there is already a campaign called ${input.name}`);

  const d = db(env);
  await d.batch([
    d.insert(schema.campaigns).values({
      id,
      name: input.name,
      kind: input.kind,
      ...columns(input),
    }),
    d.insert(schema.auditLog).values({
      id: crypto.randomUUID(),
      actorUserId: actor,
      action: "campaign.create",
      targetType: "campaign",
      targetId: id,
      detail: { after: columns(input) },
    }),
  ]);

  // FORMING by default, and nobody gets to skip that here: starting a campaign
  // is what closes its roster, and it goes through `transition`.
  return id;
}

export async function updateCampaign(
  env: Env,
  id: string,
  input: Partial<CampaignInput>,
  actor: string,
): Promise<void> {
  const before = await db(env)
    .select()
    .from(schema.campaigns)
    .where(eq(schema.campaigns.id, id))
    .get();
  if (!before) throw new InvalidCampaign(`no campaign ${id}`);

  // The row as it will be afterwards, not the request. See `validate`.
  validate(input, { ...(before as unknown as Partial<CampaignInput>), ...input });

  const changes = columns(input);
  if (Object.keys(changes).length === 0) return;

  const d = db(env);
  await d.batch([
    d
      .update(schema.campaigns)
      .set({ ...changes, updatedAt: sql`(unixepoch())` })
      .where(eq(schema.campaigns.id, id)),
    d.insert(schema.auditLog).values({
      id: crypto.randomUUID(),
      actorUserId: actor,
      action: "campaign.update",
      targetType: "campaign",
      targetId: id,
      // Only the fields that moved, and both sides of each. A diff is what makes
      // the log answer "who changed this, and to what" a year later.
      detail: { before: pick(before, Object.keys(changes)), after: changes },
    }),
  ]);
}

/**
 * A field left `undefined` is one this request said nothing about, and it is
 * left exactly as it was. That distinction is the whole point of `PATCH`: the
 * console's campaign form sends what its page holds, and a partial edit must not
 * blank the ids somebody pasted in on a different page.
 */
const WRITABLE = [
  "name",
  "kind",
  "gameId",
  "discordChannelId",
  "discordRoleId",
  "discordVoiceChannelId",
  "colour",
  "locationType",
  "recurrenceAnchor",
  "intervalWeeks",
  "quorum",
  "capacity",
  "maxSessions",
  "firstSessionNumber",
] as const;

type CampaignColumns = Partial<typeof schema.campaigns.$inferInsert>;

function columns(input: Partial<CampaignInput>): CampaignColumns {
  const out: CampaignColumns = {};
  for (const field of WRITABLE) {
    if (input[field] !== undefined) (out as Record<string, unknown>)[field] = input[field];
  }
  return out;
}

function pick(row: Record<string, unknown>, fields: string[]): Record<string, unknown> {
  return Object.fromEntries(fields.map((field) => [field, row[field]]));
}
