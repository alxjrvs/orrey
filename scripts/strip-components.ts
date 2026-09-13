/**
 * Neutralises Hermuz's old interactive posts at cutover.
 *
 * Hermuz's custom_ids are unknown to Orrey; an unhandled click shows Discord's
 * "interaction failed". Orrey's catch-all answers "this post is retired", but a
 * button that does nothing is still a button, so the buttons come off.
 *
 * This is THE ONE sanctioned use of the channel message-edit endpoint, and only
 * at cutover. Nothing in the Worker calls it. Do not generalise this script.
 *
 *   # scan channels for anything the application posted that still has buttons:
 *   op run --env-file=.env.op -- node --experimental-strip-types \
 *     scripts/strip-components.ts --scan <channel-id> [<channel-id> ...]
 *
 *   # or feed explicit "<channel-id> <message-id>" pairs on stdin
 *   printf '%s %s\n' 111 222 | op run --env-file=.env.op -- node --experimental-strip-types \
 *     scripts/strip-components.ts
 *
 *   # add --apply to actually edit. Without it, nothing is written.
 *
 * Needs DISCORD_BOT_TOKEN and DISCORD_APPLICATION_ID in the environment.
 */
import { DiscordError, discordFetch, stripComponents } from "../src/discord/rest.ts";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const scan = args.includes("--scan");
const botToken = process.env.DISCORD_BOT_TOKEN;
const applicationId = process.env.DISCORD_APPLICATION_ID;

if (!botToken || !applicationId) {
  console.error("Set DISCORD_BOT_TOKEN and DISCORD_APPLICATION_ID.");
  process.exit(1);
}
const auth = { DISCORD_BOT_TOKEN: botToken };

interface Message {
  id: string;
  channel_id: string;
  author: { id: string };
  components?: unknown[];
  timestamp: string;
}

/** channel id -> message ids */
const targets = new Map<string, Set<string>>();
const add = (channel: string, message: string) => {
  if (!targets.has(channel)) targets.set(channel, new Set());
  targets.get(channel)!.add(message);
};

if (scan) {
  const channels = args.filter((a) => !a.startsWith("--"));
  if (channels.length === 0) {
    console.error("--scan needs at least one channel id.");
    process.exit(1);
  }
  for (const channel of channels) {
    let before: string | undefined;
    let seen = 0;
    for (;;) {
      let page: Message[];
      try {
        page = await paced(() =>
          discordFetch<Message[]>(
            auth,
            `/channels/${channel}/messages?limit=100${before ? `&before=${before}` : ""}`,
          ),
        );
      } catch (error) {
        // 50001 Missing Access — a role-gated channel the bot cannot read. It
        // cannot have posted there either, so there is nothing to strip.
        if (error instanceof DiscordError && error.code === 50001) {
          console.error(`no access to ${channel}; skipped`);
          break;
        }
        throw error;
      }
      if (page.length === 0) break;
      seen += page.length;
      for (const m of page) {
        if (m.author.id === applicationId && (m.components?.length ?? 0) > 0) add(channel, m.id);
      }
      before = page[page.length - 1]!.id;
    }
    console.error(`scanned ${seen} messages in ${channel}`);
  }
} else {
  const stdin = await new Response(process.stdin as unknown as ReadableStream).text();
  for (const line of stdin.split("\n")) {
    const [channel, message] = line.trim().split(/\s+/);
    if (channel && message) add(channel, message);
  }
}

const total = [...targets.values()].reduce((n, s) => n + s.size, 0);
console.log(`${apply ? "Stripping" : "Would strip"} components from ${total} message(s)`);

let stripped = 0;
let skipped = 0;
for (const [channel, messages] of targets) {
  for (const message of messages) {
    if (!apply) {
      console.log(`  ${channel}/${message}`);
      continue;
    }
    try {
      await paced(() => stripComponents(auth, channel, message));
      stripped++;
      console.log(`  stripped ${channel}/${message}`);
    } catch (error) {
      // 10008 Unknown Message — already deleted. Nothing to neutralise.
      if (error instanceof DiscordError && error.code === 10008) {
        skipped++;
        console.log(`  gone     ${channel}/${message}`);
      } else {
        throw error;
      }
    }
  }
}

if (apply) console.log(`Done: ${stripped} stripped, ${skipped} already gone.`);
else console.log("Dry run. Re-run with --apply to edit.");

/** Sequential, and honours 429s — a one-off script gets no GuildGovernor. */
async function paced<T>(work: () => Promise<T>): Promise<T> {
  for (;;) {
    try {
      const result = await work();
      await new Promise((r) => setTimeout(r, 350));
      return result;
    } catch (error) {
      if (error instanceof DiscordError && error.status === 429) {
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }
      throw error;
    }
  }
}
