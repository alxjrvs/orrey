/**
 * Bulk-overwrites the application's guild command set.
 *
 * This is the step that makes Hermuz's commands cease to exist: PUT replaces
 * the whole set, it does not merge. Run it at cutover and after any change to
 * src/discord/commands.ts.
 *
 *   DISCORD_APPLICATION_ID=… DISCORD_BOT_TOKEN=… DISCORD_GUILD_ID=… \
 *     npm run commands:register
 *
 * Pass --clear to remove every command instead.
 */
import { commands } from "../src/discord/commands.ts";

const applicationId = process.env.DISCORD_APPLICATION_ID;
const botToken = process.env.DISCORD_BOT_TOKEN;
const guildId = process.env.DISCORD_GUILD_ID;

if (!applicationId || !botToken || !guildId) {
  console.error("Set DISCORD_APPLICATION_ID, DISCORD_BOT_TOKEN and DISCORD_GUILD_ID.");
  process.exit(1);
}

const clear = process.argv.includes("--clear");
const body = clear ? [] : commands;

const response = await fetch(
  `https://discord.com/api/v10/applications/${applicationId}/guilds/${guildId}/commands`,
  {
    method: "PUT",
    headers: { Authorization: `Bot ${botToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  },
);

if (!response.ok) {
  console.error(response.status, await response.text());
  process.exit(1);
}

const registered = (await response.json()) as { name: string }[];
console.log(`${clear ? "Cleared" : "Registered"} ${registered.length} command(s) in guild ${guildId}`);
for (const command of registered) console.log(`  /${command.name}`);
