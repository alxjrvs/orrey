/**
 * Lists the Discord objects Orrey adopts — issue #10.
 *
 * Orrey takes over the guild's existing roles, channels and scheduled events
 * rather than creating a parallel set, and the application is the same one
 * Hermuz used, so it already has authorship of them. There is no database to
 * import from: Hermuz's D1 is empty, so the ids are read from Discord itself
 * with the bot token.
 *
 *   op run --env-file=.env.op -- node --experimental-strip-types scripts/adopt-ids.ts
 *       [--json <out.json>] [--sql --scheduling-channel <id> [--timezone <iana>]]
 *
 *   (default)     a readable listing: roles (with member-visible colour), text
 *                 channels grouped by category, and every scheduled event with
 *                 its creator — the ones created by this application are the
 *                 ones Orrey inherits
 *   --json FILE   the same, as a file to keep for phase 2 (#26)
 *   --sql         INSERTs for Orrey's `settings`, to pipe into
 *                 `wrangler d1 execute orrey --remote --file`. The scheduling
 *                 channel is a human choice, so it is passed explicitly.
 *
 * Needs DISCORD_BOT_TOKEN, DISCORD_APPLICATION_ID and DISCORD_GUILD_ID. Prints
 * ids only — snowflakes are not secrets.
 */
import { writeFileSync } from "node:fs";
import { discordFetch } from "../src/discord/rest.ts";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const value = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const botToken = process.env.DISCORD_BOT_TOKEN;
const applicationId = process.env.DISCORD_APPLICATION_ID;
const guildId = process.env.DISCORD_GUILD_ID;
if (!botToken || !applicationId || !guildId) {
  console.error("Set DISCORD_BOT_TOKEN, DISCORD_APPLICATION_ID and DISCORD_GUILD_ID (via op run).");
  process.exit(1);
}
const auth = { DISCORD_BOT_TOKEN: botToken };

interface Guild { id: string; name: string }
interface Role { id: string; name: string; color: number; managed: boolean; position: number }
interface Channel { id: string; name: string; type: number; parent_id: string | null; position: number }
interface ScheduledEvent {
  id: string;
  name: string;
  scheduled_start_time: string;
  status: number;
  entity_type: number;
  channel_id: string | null;
  creator_id?: string;
  entity_metadata?: { location?: string } | null;
}

const GUILD_TEXT = 0;
const GUILD_CATEGORY = 4;
const GUILD_VOICE = 2;
const EVENT_STATUS = { 1: "scheduled", 2: "active", 3: "completed", 4: "cancelled" } as Record<number, string>;

const [guild, roles, channels, events] = await Promise.all([
  discordFetch<Guild>(auth, `/guilds/${guildId}`),
  discordFetch<Role[]>(auth, `/guilds/${guildId}/roles`),
  discordFetch<Channel[]>(auth, `/guilds/${guildId}/channels`),
  discordFetch<ScheduledEvent[]>(auth, `/guilds/${guildId}/scheduled-events`),
]);

const categories = new Map(channels.filter((c) => c.type === GUILD_CATEGORY).map((c) => [c.id, c.name]));

const adopted = {
  capturedAt: new Date().toISOString(),
  guild: { id: guild.id, name: guild.name },
  applicationId,
  roles: roles
    .filter((r) => r.id !== guildId && !r.managed) // drop @everyone and bot/integration roles
    .sort((a, b) => b.position - a.position)
    .map((r) => ({ id: r.id, name: r.name, colour: r.color ? `#${r.color.toString(16).padStart(6, "0")}` : null })),
  channels: channels
    .filter((c) => c.type === GUILD_TEXT || c.type === GUILD_VOICE)
    .sort((a, b) => (categories.get(a.parent_id ?? "") ?? "").localeCompare(categories.get(b.parent_id ?? "") ?? "") || a.position - b.position)
    .map((c) => ({ id: c.id, name: c.name, kind: c.type === GUILD_VOICE ? "voice" : "text", category: categories.get(c.parent_id ?? "") ?? null })),
  scheduledEvents: events
    .sort((a, b) => a.scheduled_start_time.localeCompare(b.scheduled_start_time))
    .map((e) => ({
      id: e.id,
      name: e.name,
      startsAt: e.scheduled_start_time,
      status: EVENT_STATUS[e.status] ?? String(e.status),
      where: e.channel_id ?? e.entity_metadata?.location ?? null,
      createdByThisApplication: e.creator_id === applicationId,
    })),
};

if (flag("sql")) {
  const schedulingChannelId = value("scheduling-channel");
  if (!schedulingChannelId || !adopted.channels.some((c) => c.id === schedulingChannelId)) {
    console.error("--sql needs --scheduling-channel <id> naming a text channel in this guild.");
    process.exit(1);
  }
  const rows: [string, unknown][] = [
    ["discord.guild_id", adopted.guild.id],
    ["discord.scheduling_channel_id", schedulingChannelId],
    ["timezone", value("timezone") ?? "America/New_York"],
  ];
  for (const [key, v] of rows) {
    const json = JSON.stringify(v).replaceAll("'", "''");
    console.log(
      `INSERT INTO settings (key, value) VALUES ('${key}', '${json}')\n` +
        `  ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = unixepoch();`,
    );
  }
} else {
  const pad = (s: string, n: number) => s.padEnd(n);
  console.log(`${guild.name}  guild=${guild.id}  application=${applicationId}\n`);

  console.log(`roles (${adopted.roles.length})`);
  for (const r of adopted.roles) console.log(`  ${pad(r.id, 20)} ${pad(r.name, 28)} ${r.colour ?? ""}`);

  console.log(`\nchannels (${adopted.channels.length})`);
  let lastCategory: string | null | undefined;
  for (const c of adopted.channels) {
    if (c.category !== lastCategory) {
      console.log(`  [${c.category ?? "no category"}]`);
      lastCategory = c.category;
    }
    console.log(`    ${pad(c.id, 20)} ${c.kind === "voice" ? "🔊" : "#"}${c.name}`);
  }

  console.log(`\nscheduled events (${adopted.scheduledEvents.length})`);
  for (const e of adopted.scheduledEvents) {
    console.log(
      `  ${pad(e.id, 20)} ${e.startsAt}  ${pad(e.status, 9)} ${e.createdByThisApplication ? "ours" : "    "} ${e.name}`,
    );
  }
  console.log("\n'ours' = created by this application: Orrey inherits authorship of those.");
}

const out = value("json");
if (out) {
  writeFileSync(out, `${JSON.stringify(adopted, null, 2)}\n`);
  console.error(`wrote ${out}`);
}
