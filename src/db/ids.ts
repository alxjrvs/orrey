/**
 * Ids Orrey mints for its own rows.
 *
 * A poll id and a poll-date id ride inside a component `custom_id`, and
 * `encodeCustomId` throws past 100 characters. So the length of an id is a
 * schema decision rather than a detail: twelve base32hex characters is sixty
 * bits, which leaves `o1:poll:select:<id>` at thirty characters and no room for
 * an outage that only shows up once somebody opens a poll.
 *
 * Unguessability is not the point here — a poll id is on a post the whole server
 * can see, and what stops a player closing a poll is the organiser check, never
 * the id. The point is collision resistance across the handful of polls a guild
 * opens in a year, and sixty random bits is far past that.
 */
const ALPHABET = "0123456789abcdefghijklmnopqrstuv";

export const ID_LENGTH = 12;

export function mintId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(ID_LENGTH));
  let out = "";
  for (const byte of bytes) out += ALPHABET[byte & 31];
  return out;
}
