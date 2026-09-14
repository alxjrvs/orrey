import { encodeCustomId } from "../discord/custom-id.ts";
import { ButtonStyle, ComponentType } from "../discord/types.ts";

/**
 * **Suggest another day** — one mint, two places.
 *
 * It sits on the attendance post and on the jeopardy notice, which are the two
 * moments somebody realises a date is wrong: scanning the post, or being told a
 * day out that the session is short. Both render this helper, so there is one id
 * and one handler rather than two that drift.
 *
 * The id carries the session and no argument, because there is nothing to argue
 * about: the button means one thing.
 */
export function suggestButton(sessionId: string): Record<string, unknown> {
  return {
    type: ComponentType.BUTTON,
    style: ButtonStyle.SECONDARY,
    label: "Suggest another day",
    custom_id: encodeCustomId({ action: "suggest", target: sessionId }),
  };
}

/**
 * Its own row, and it has to be: In / Out / Maybe / Note / Refresh is already
 * five, which is Discord's limit per row.
 */
export function suggestRow(sessionId: string): Record<string, unknown> {
  return { type: ComponentType.ACTION_ROW, components: [suggestButton(sessionId)] };
}
