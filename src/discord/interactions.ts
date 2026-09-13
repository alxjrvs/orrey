import type { Env } from "../env.ts";
import { decodeCustomId, encodeCustomId } from "./custom-id.ts";
import { deleteUserData, describeReceipt } from "../privacy/delete.ts";
import {
  ButtonStyle,
  ComponentType,
  InteractionResponseType,
  InteractionType,
  MessageFlags,
  actorOf,
  type Interaction,
} from "./types.ts";

type Json = Record<string, unknown>;

/** Where this Worker is answering from, so responses can link to its own pages. */
export interface InteractionContext {
  origin: string;
}

function ephemeral(content: string, components: Json[] = []): Json {
  return {
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: { content, flags: MessageFlags.EPHEMERAL, components },
  };
}

/** The one write to an existing message Orrey makes: this interaction's own response. */
function rewrite(content: string, components: Json[] = []): Json {
  return { type: InteractionResponseType.UPDATE_MESSAGE, data: { content, components } };
}

function row(...buttons: Json[]): Json {
  return { type: ComponentType.ACTION_ROW, components: buttons };
}

function button(label: string, customId: string, style: number = ButtonStyle.SECONDARY): Json {
  return { type: ComponentType.BUTTON, style, label, custom_id: customId };
}

/**
 * Every interaction Discord can send us. The endpoint must handle all four of
 * COMMAND, AUTOCOMPLETE, MESSAGE_COMPONENT and MODAL_SUBMIT: autocomplete is
 * what lets /reschedule name an event.
 */
export async function handleInteraction(
  interaction: Interaction,
  env: Env,
  ctx: InteractionContext,
): Promise<Json> {
  switch (interaction.type) {
    case InteractionType.PING:
      return { type: InteractionResponseType.PONG };

    case InteractionType.APPLICATION_COMMAND:
      return handleCommand(interaction, env, ctx);

    case InteractionType.APPLICATION_COMMAND_AUTOCOMPLETE:
      return {
        type: InteractionResponseType.APPLICATION_COMMAND_AUTOCOMPLETE_RESULT,
        data: { choices: [] },
      };

    case InteractionType.MESSAGE_COMPONENT:
      return handleComponent(interaction, env, ctx);

    case InteractionType.MODAL_SUBMIT:
      return ephemeral("Not wired up yet.");

    default:
      return ephemeral("Orrey does not know what to do with that.");
  }
}

async function handleCommand(
  interaction: Interaction,
  _env: Env,
  ctx: InteractionContext,
): Promise<Json> {
  switch (interaction.data?.name) {
    case "upcoming":
      return ephemeral("Nothing scheduled yet — Orrey is still being built.");
    case "reschedule":
      return ephemeral("Date polls arrive in phase 4.");
    case "whos-in":
      return ephemeral("Rosters arrive in phase 2.");
    case "console":
      return console_(ctx);
    default:
      return ephemeral("Unknown command.");
  }
}

/**
 * Until the console exists (phase 2), `/console` is where the two things
 * Discord's terms require live: the privacy policy, and a way out.
 */
function console_(ctx: InteractionContext): Json {
  return ephemeral(
    [
      "The console arrives in phase 2. Until then:",
      "",
      `**What Orrey knows about you** — <${ctx.origin}/privacy>`,
    ].join("\n"),
    [row(button("Delete my data", encodeCustomId({ action: "privacy", arg: "delete" }), ButtonStyle.DANGER))],
  );
}

/**
 * A click may rewrite the message it came from, as that interaction's own
 * response — the single exception to send-only. Nothing else ever edits a post.
 */
async function handleComponent(
  interaction: Interaction,
  env: Env,
  ctx: InteractionContext,
): Promise<Json> {
  const id = decodeCustomId(interaction.data?.custom_id ?? "");

  // Unrecognised id: a Hermuz-era post, or one minted by an older schema.
  if (!id) return retiredPost();

  switch (id.action) {
    case "ping":
      return rewrite(`Pong — round-tripped at ${new Date().toISOString()}.`);
    case "privacy":
      return handlePrivacy(interaction, env, ctx, id.arg);
    default:
      return retiredPost();
  }
}

async function handlePrivacy(
  interaction: Interaction,
  env: Env,
  ctx: InteractionContext,
  arg: string | undefined,
): Promise<Json> {
  const actor = actorOf(interaction);
  if (!actor) return ephemeral("Orrey could not tell who clicked that.");

  switch (arg) {
    case "delete":
      return rewrite(
        [
          "**Delete everything Orrey holds about you?**",
          "",
          "That is your row, your attendance history, and your calendar feed token —",
          "the feed stops working straight away. It does not remove you from the server,",
          "and it cannot be undone.",
          "",
          `What that covers: <${ctx.origin}/privacy>`,
        ].join("\n"),
        [
          row(
            button(
              "Yes, delete it",
              encodeCustomId({ action: "privacy", arg: "confirm" }),
              ButtonStyle.DANGER,
            ),
            button("Keep it", encodeCustomId({ action: "privacy", arg: "cancel" })),
          ),
        ],
      );

    case "confirm": {
      const receipt = await deleteUserData(env, actor.id);
      return rewrite(`**Done.** ${describeReceipt(receipt)}`);
    }

    case "cancel":
      return rewrite("Nothing deleted.");

    default:
      return retiredPost();
  }
}

function retiredPost(): Json {
  return ephemeral("This post is retired — its buttons no longer do anything. Try `/upcoming`.");
}
