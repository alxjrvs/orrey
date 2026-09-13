/**
 * Seeds the one hardcoded campaign and its next session — issue #16.
 *
 * Phase 1 has no console and no cadence, so the row that everything else in the
 * phase projects from is entered by hand. This prints SQL and writes nothing:
 * D1 is remote, so the operator reads it and then pipes it in, the same way the
 * cutover seeds `settings`.
 *
 *   node --experimental-strip-types scripts/seed-session.ts \
 *     --name "Age of Umbra" --kind run \
 *     --from ops/adopted-ids.json --role-name "Age of Umbra" --channel-name age-of-umbra \
 *     --number 12 --starts 2026-09-20T19:00:00Z --hours 4 --location "The Wreck" \
 *     > ops/seed-session.sql
 *
 *   npx wrangler d1 execute orrey --remote --file ops/seed-session.sql
 *
 *   --from FILE        the capture from `scripts/adopt-ids.ts --json`, so the
 *                      role and channel are named rather than pasted
 *   --role / --channel ids, when you would rather paste them
 *   --voice ID         a VOICE campaign instead of an EXTERNAL one
 *   --ends ISO         instead of --hours
 *
 * Re-running it is the normal case: the times move, the ids do not.
 */
import { readFileSync } from "node:fs";
import { seedStatements, slugify, type CampaignSeed, type SessionSeed } from "../src/db/seed-sql.ts";

const args = process.argv.slice(2);
const value = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

interface Adopted {
  roles: { id: string; name: string; colour: string | null }[];
  channels: { id: string; name: string; kind: "text" | "voice" }[];
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const name = value("name") ?? fail("--name is the campaign's name, as it reads in Discord.");
const kind = (value("kind") ?? "run") as CampaignSeed["kind"];
if (!["run", "play", "tracked"].includes(kind)) fail("--kind is run, play or tracked.");

const startsIso = value("starts") ?? fail("--starts is an ISO time, e.g. 2026-09-20T19:00:00Z.");
const startsAt = Math.floor(Date.parse(startsIso) / 1000);
if (Number.isNaN(startsAt)) fail(`--starts ${startsIso} is not a time.`);

const endsIso = value("ends");
const hours = Number(value("hours") ?? 4);
const endsAt = endsIso ? Math.floor(Date.parse(endsIso) / 1000) : startsAt + Math.round(hours * 3600);
if (Number.isNaN(endsAt)) fail(`--ends ${endsIso} is not a time.`);

// The capture from adopt-ids.ts, so the operator names the role and channel
// they already read in that listing rather than re-copying snowflakes.
let adopted: Adopted | undefined;
const from = value("from");
if (from) adopted = JSON.parse(readFileSync(from, "utf8")) as Adopted;

function findChannel(named: string | undefined, kinds: ("text" | "voice")[]): string | undefined {
  if (!named) return undefined;
  if (!adopted) fail("--channel-name / --voice-name need --from <adopted-ids.json>.");
  const match = adopted.channels.find((c) => c.name === named && kinds.includes(c.kind));
  return match?.id ?? fail(`no ${kinds.join(" or ")} channel called ${named} in that capture.`);
}

const roleName = value("role-name");
const role = roleName
  ? (adopted ?? fail("--role-name needs --from <adopted-ids.json>.")).roles.find((r) => r.name === roleName) ??
    fail(`no role called ${roleName} in that capture.`)
  : undefined;

const campaign: CampaignSeed = {
  id: value("id") ?? slugify(name),
  name,
  kind,
  discordChannelId: value("channel") ?? findChannel(value("channel-name"), ["text"]) ?? null,
  discordRoleId: value("role") ?? role?.id ?? null,
  colour: parseColour(value("colour") ?? role?.colour ?? null),
  locationType: value("voice") || value("voice-name") ? "voice" : "external",
  discordVoiceChannelId: value("voice") ?? findChannel(value("voice-name"), ["voice"]) ?? null,
};

const session: SessionSeed = {
  number: value("number") === undefined ? null : Number(value("number")),
  startsAt,
  endsAt,
  location: value("location") ?? null,
};

/** adopt-ids.ts writes `#rrggbb`; Discord itself stores the integer. */
function parseColour(colour: string | number | null): number | null {
  if (colour === null) return null;
  if (typeof colour === "number") return colour;
  const parsed = Number.parseInt(colour.replace(/^#/, ""), 16);
  return Number.isNaN(parsed) ? null : parsed;
}

let statements: string[];
try {
  statements = seedStatements(campaign, session);
} catch (error) {
  fail(String(error instanceof Error ? error.message : error));
}

console.error(
  `-- ${campaign.name} (${campaign.id}) — session ${session.number ?? "un-numbered"}, ` +
    `${new Date(startsAt * 1000).toISOString()} → ${new Date(endsAt * 1000).toISOString()}`,
);
for (const statement of statements) console.log(`${statement};`);
