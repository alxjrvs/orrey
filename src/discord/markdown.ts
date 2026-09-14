/**
 * Escaping somebody else's text into a post Orrey can never edit.
 *
 * It lives here rather than beside one renderer because it is not about
 * attendance: a note, a poll's title, a campaign's name and a game's name all
 * arrive from a person and all end up in a message that is send-only. The
 * second renderer in the repo is the moment keeping it next to the first stops
 * being tidy and starts being a copy waiting to diverge.
 *
 * Unescaped, a note reading `**Out (4)** — Bob, Cara` renders as a heading of
 * Orrey's own shape, and a stray backtick reflows everything after it — the
 * as-of line included. So the markdown somebody else's text can use is the
 * markdown it escapes.
 *
 * Only the inline set: the text this is given is normalised to one line and
 * never rendered at the start of one, so `#` and `>` cannot open a block.
 */
export function escapeMarkdown(text: string): string {
  return text.replace(/([*_`~|\\])/g, "\\$1");
}
