import type { Env } from "../env.ts";
import { decodeCustomId, encodeCustomId } from "./custom-id.ts";
import { deleteUserData, describeReceipt } from "../privacy/delete.ts";
import { correctionPost, renderAttendancePost } from "../attendance/render.ts";
import { registerRows } from "../attendance/assume.ts";
import { isGm } from "../campaigns/roster.ts";
import { loadProjectionTarget } from "../projection/target.ts";
import type { SmokeTally } from "../do/session-lock.ts";
import {
  ButtonStyle,
  ComponentType,
  InteractionResponseType,
  InteractionType,
  MessageFlags,
  TextInputStyle,
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
      return handleModal(interaction, env);

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
    case "attend":
      return handleAttend(interaction, env, id.arg, id.target);
    case "attended":
      return handleAttended(interaction, env, id.arg, id.target);
    case "ping":
      return handlePing(interaction, env, id.target ?? "default");
    case "privacy":
      return handlePrivacy(interaction, env, ctx, id.arg);
    default:
      return retiredPost();
  }
}

/**
 * In / Out / Maybe / Refresh on an attendance post. The shape the smoke test
 * proved: serialise behind the session's lock, write to D1, re-render from what
 * was just written, and answer with UPDATE_MESSAGE so the click rewrites the
 * message it came from. The message itself is never read — a post is a
 * snapshot of D1, never a record of anything.
 */
async function handleAttend(
  interaction: Interaction,
  env: Env,
  arg: string | undefined,
  sessionId: string | undefined,
): Promise<Json> {
  if (!sessionId) return retiredPost();

  const actor = actorOf(interaction);
  if (!actor) return ephemeral("Orrey could not tell who clicked that.");

  // The session is gone, so the post in front of them is about nothing.
  const target = await loadProjectionTarget(env, sessionId);
  if (!target) return retiredPost();

  const lock = env.SESSION_LOCK.get(env.SESSION_LOCK.idFromName(sessionId));
  let rows;
  switch (arg) {
    case "in":
    case "out":
    case "maybe":
      rows = await lock.setIntent({ sessionId, actor, intent: arg });
      break;
    case "refresh":
      rows = await lock.readIntents(sessionId);
      break;
    case "note": {
      // Prefilled with what is stored: the box comes back empty when the person
      // clears it, and an empty box means "clear it", so an unprefilled modal
      // would wipe a note just by being opened and submitted.
      const mine = (await lock.readIntents(sessionId)).find((row) => row.userId === actor.id);
      return noteModal(sessionId, mine?.note ?? "");
    }
    default:
      return retiredPost();
  }

  // Re-read: the click may have been the one that crossed quorum, and the
  // session it confirmed is the session this response has to render. Rendering
  // the target we loaded a moment ago would show the crossing click everything
  // except the thing it just did.
  const settled = (await loadProjectionTarget(env, sessionId)) ?? target;

  return {
    type: InteractionResponseType.UPDATE_MESSAGE,
    data: renderAttendancePost({ target: settled, rows, asOf: new Date() }),
  };
}

/**
 * One toggle on the correction post. The organiser's alone: the register is what
 * flake memory reads, and a register anybody can edit is a register nobody can
 * rely on.
 *
 * Everyone else gets an ephemeral sentence rather than a silent no-op, because a
 * button that appears to do nothing reads as broken rather than as forbidden.
 */
async function handleAttended(
  interaction: Interaction,
  env: Env,
  userId: string | undefined,
  sessionId: string | undefined,
): Promise<Json> {
  if (!userId || !sessionId) return retiredPost();

  const actor = actorOf(interaction);
  if (!actor) return ephemeral("Orrey could not tell who clicked that.");

  const target = await loadProjectionTarget(env, sessionId);
  if (!target) return retiredPost();

  if (!target.campaign || !(await isGm(env, target.campaign.id, actor.id))) {
    return ephemeral("Only whoever ran the session can correct the register.");
  }

  const lock = env.SESSION_LOCK.get(env.SESSION_LOCK.idFromName(sessionId));
  await lock.toggleAttended({ sessionId, userId });

  // Rendered from what was just written, and returned as this click's own
  // response — the one rewrite send-only allows.
  return {
    type: InteractionResponseType.UPDATE_MESSAGE,
    data: correctionPost(target, await registerRows(env, sessionId), new Date()),
  };
}

/**
 * Note opens a modal. Its id is minted the same way every other component id
 * is, so the submission that comes back minutes later is recognised — or, if it
 * comes back after a schema change, degrades to the retired-post response like
 * any other id Orrey no longer understands.
 */
function noteModal(sessionId: string, current: string): Json {
  return {
    type: InteractionResponseType.MODAL,
    data: {
      custom_id: encodeCustomId({ action: "attend-note", target: sessionId }),
      title: "Add a note",
      components: [
        {
          type: ComponentType.ACTION_ROW,
          components: [
            {
              type: ComponentType.TEXT_INPUT,
              custom_id: NOTE_INPUT,
              style: TextInputStyle.SHORT,
              label: "Anything the others should know?",
              placeholder: "Running 30 late",
              value: current,
              max_length: 140,
              required: false,
            },
          ],
        },
      ],
    },
  };
}

const NOTE_INPUT = "note";

/**
 * A modal launched from a message component may answer with UPDATE_MESSAGE, so
 * the note lands and the post it came from rewrites itself — the same single
 * exception to send-only that a button click uses.
 */
async function handleModal(interaction: Interaction, env: Env): Promise<Json> {
  const id = decodeCustomId(interaction.data?.custom_id ?? "");
  if (!id || id.action !== "attend-note" || !id.target) return retiredPost();

  const actor = actorOf(interaction);
  if (!actor) return ephemeral("Orrey could not tell who submitted that.");

  const target = await loadProjectionTarget(env, id.target);
  if (!target) return retiredPost();

  const note =
    interaction.data?.components
      ?.flatMap((row) => row.components)
      .find((input) => input.custom_id === NOTE_INPUT)?.value ?? "";

  const lock = env.SESSION_LOCK.get(env.SESSION_LOCK.idFromName(id.target));
  const rows = await lock.setNote({ sessionId: id.target, actor, note });
  const settled = (await loadProjectionTarget(env, id.target)) ?? target;

  return {
    type: InteractionResponseType.UPDATE_MESSAGE,
    data: renderAttendancePost({ target: settled, rows, asOf: new Date() }),
  };
}

/**
 * The phase-0 exit criterion, and the shape every later button follows: route
 * through the session's Durable Object so concurrent clicks serialise, write to
 * D1, then render what was just written as this interaction's own response.
 *
 * The button survives the rewrite. A post is a snapshot, so it carries an
 * as-of line and stays clickable — which is also how the 15-minute interaction
 * token stops mattering: the next click is a fresh interaction.
 */
async function handlePing(interaction: Interaction, env: Env, target: string): Promise<Json> {
  const actor = actorOf(interaction);
  if (!actor) return ephemeral("Orrey could not tell who clicked that.");

  const lock = env.SESSION_LOCK.get(env.SESSION_LOCK.idFromName(target));
  const tally = await lock.click(target, actor);

  return rewrite(renderTally(target, tally), [
    row(button("Ping", encodeCustomId({ action: "ping", target }), ButtonStyle.PRIMARY)),
  ]);
}

function renderTally(target: string, tally: SmokeTally): string {
  const clicks = `${tally.clicks} ${tally.clicks === 1 ? "click" : "clicks"}`;
  return [
    `**Smoke test — \`${target}\`**`,
    `${clicks}, last by ${tally.lastBy ?? "someone"}.`,
    `-# As of ${tally.asOf ?? new Date().toISOString()}. Click again for a fresh reading.`,
  ].join("\n");
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
