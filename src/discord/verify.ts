/**
 * Ed25519 request verification.
 *
 * Discord validates the Interactions Endpoint URL on save, including by sending
 * a request with a deliberately bad signature and expecting a 401. Nothing else
 * in the Worker may run before this passes.
 */

const encoder = new TextEncoder();

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

// Keyed by the hex public key so a rotated key takes effect without a restart.
const keys = new Map<string, Promise<CryptoKey>>();

function importPublicKey(publicKey: string): Promise<CryptoKey> {
  let key = keys.get(publicKey);
  if (!key) {
    key = importRaw(hexToBytes(publicKey));
    keys.set(publicKey, key);
    key.catch(() => keys.delete(publicKey));
  }
  return key;
}

async function importRaw(raw: Uint8Array): Promise<CryptoKey> {
  // Workers accepts "Ed25519"; older runtimes only know "NODE-ED25519".
  try {
    return await crypto.subtle.importKey("raw", raw, { name: "Ed25519" }, false, ["verify"]);
  } catch {
    return await crypto.subtle.importKey(
      "raw",
      raw,
      { name: "NODE-ED25519", namedCurve: "NODE-ED25519" } as unknown as Parameters<
        typeof crypto.subtle.importKey
      >[2],
      false,
      ["verify"],
    );
  }
}

/** Verifies the signature over `timestamp + body`. Returns false on any malformed input. */
export async function verifyDiscordRequest(
  publicKey: string,
  signature: string | null,
  timestamp: string | null,
  body: string,
): Promise<boolean> {
  if (!signature || !timestamp) return false;
  if (!/^[0-9a-f]+$/i.test(signature) || signature.length !== 128) return false;
  try {
    const key = await importPublicKey(publicKey);
    return await crypto.subtle.verify(
      key.algorithm.name,
      key,
      hexToBytes(signature),
      encoder.encode(timestamp + body),
    );
  } catch {
    return false;
  }
}
