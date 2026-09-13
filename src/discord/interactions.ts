import type { Env } from "../env.ts";
import { decodeCustomId } from "./custom-id.ts";
import { InteractionResponseType, InteractionType, MessageFlags, type Interaction } from "./types.ts";

type Json = Record<string, unknown>;

function ephemeral(content: string): Json {
  return {
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: { content, flags: MessageFlags.EPHEMERAL },
  };
}

/**
 * Every interaction Discord can send us. The endpoint must handle all four of
 * COMMAND, AUTOCOMPLETE, MESSAGE_COMPONENT and MODAL_SUBMIT: autocomplete is
 * what lets /reschedule name an event.
 */
export async function handleInteraction(interaction: Interaction, env: Env): Promise<Json> {
  switch (interaction.type) {
    case InteractionType.PING:
      return { type: InteractionResponseType.PONG };

    case InteractionType.APPLICATION_COMMAND:
      return handleCommand(interaction, env);

    case InteractionType.APPLICATION_COMMAND_AUTOCOMPLETE:
      return {
        type: InteractionResponseType.APPLICATION_COMMAND_AUTOCOMPLETE_RESULT,
        data: { choices: [] },
      };

    case InteractionType.MESSAGE_COMPONENT:
      return handleComponent(interaction, env);

    case InteractionType.MODAL_SUBMIT:
      return ephemeral("Not wired up yet.");

    default:
      return ephemeral("Orrey does not know what to do with that.");
  }
}

async function handleCommand(interaction: Interaction, _env: Env): Promise<Json> {
  switch (interaction.data?.name) {
    case "upcoming":
      return ephemeral("Nothing scheduled yet — Orrey is still being built.");
    case "reschedule":
      return ephemeral("Date polls arrive in phase 4.");
    case "whos-in":
      return ephemeral("Rosters arrive in phase 2.");
    case "console":
      return ephemeral("The console arrives in phase 2.");
    default:
      return ephemeral("Unknown command.");
  }
}

/**
 * A click may rewrite the message it came from, as that interaction's own
 * response — the single exception to send-only. Nothing else ever edits a post.
 */
async function handleComponent(interaction: Interaction, _env: Env): Promise<Json> {
  const id = decodeCustomId(interaction.data?.custom_id ?? "");

  // Unrecognised id: a Hermuz-era post, or one minted by an older schema.
  if (!id) return retiredPost();

  switch (id.action) {
    case "ping":
      return {
        type: InteractionResponseType.UPDATE_MESSAGE,
        data: { content: `Pong — round-tripped at ${new Date().toISOString()}.`, components: [] },
      };
    default:
      return retiredPost();
  }
}

function retiredPost(): Json {
  return ephemeral("This post is retired — its buttons no longer do anything. Try `/upcoming`.");
}
