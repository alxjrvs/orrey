/**
 * Google lets the client choose an event id, within base32hex (`a-v`, `0-9`,
 * 5–1024 chars). Orrey mints one deterministically from its own session id, so
 * an upsert is `insert`, and on 409 `update` — no lookup, no duplicate, and a
 * retried queue message lands on the same event.
 */
const ALPHABET = "0123456789abcdefghijklmnopqrstuv";

export async function eventIdFor(sessionId: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`orrey:${sessionId}`));
  return base32hex(new Uint8Array(digest)).slice(0, 32);
}

export function isValidEventId(id: string): boolean {
  return /^[0-9a-v]{5,1024}$/.test(id);
}

function base32hex(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}
