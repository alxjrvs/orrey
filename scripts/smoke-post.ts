/**
 * Posts the phase-0 smoke-test message: one button, whose click round-trips to
 * D1 and rewrites this message as the interaction's own response.
 *
 * Run it against the deployed Worker, in the real guild, after cutover:
 *
 *   op run --env-file=.env.op -- \
 *     node --experimental-strip-types scripts/smoke-post.ts <channel-id> [target]
 *
 * The token comes from the environment and is never printed. What is printed is
 * the message id, so the post can be found and deleted afterwards.
 */
import { encodeCustomId } from "../src/discord/custom-id.ts";
import { postMessage } from "../src/discord/rest.ts";
import { ButtonStyle, ComponentType } from "../src/discord/types.ts";

const [channelId, target = "phase-0"] = process.argv.slice(2);
const botToken = process.env.DISCORD_BOT_TOKEN;

if (!channelId || !botToken) {
  console.error("Usage: smoke-post.ts <channel-id> [target]   (DISCORD_BOT_TOKEN must be set)");
  process.exit(1);
}

const message = await postMessage({ DISCORD_BOT_TOKEN: botToken }, channelId, {
  content: [
    `**Smoke test — \`${target}\`**`,
    "No clicks yet.",
    "-# Click the button. Orrey writes to D1 and rewrites this message.",
  ].join("\n"),
  components: [
    {
      type: ComponentType.ACTION_ROW,
      components: [
        {
          type: ComponentType.BUTTON,
          style: ButtonStyle.PRIMARY,
          label: "Ping",
          custom_id: encodeCustomId({ action: "ping", target }),
        },
      ],
    },
  ],
});

console.log(`Posted ${message.id} in channel ${message.channel_id}.`);
console.log("Click it, wait 15+ minutes, click it again: both must rewrite the message.");
