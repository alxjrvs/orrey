/**
 * A stand-in for Discord: an Ed25519 keypair minted once per test file, and a
 * helper that signs a body the way Discord does (`timestamp + body`).
 */
import type { Env } from "../src/env.ts";

const encoder = new TextEncoder();

function bytesToHex(bytes: ArrayBuffer | Uint8Array): string {
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** A guaranteed-different signature of the right shape — never a no-op. */
function flipFirstByte(hex: string): string {
  const first = Number.parseInt(hex.slice(0, 2), 16) ^ 0xff;
  return first.toString(16).padStart(2, "0") + hex.slice(2);
}

export interface FakeDiscord {
  publicKeyHex: string;
  sign(body: string, timestamp?: string): Promise<{ signature: string; timestamp: string }>;
  /** A signed POST /interactions request, as Discord would send it. */
  request(body: unknown, opts?: { tamper?: boolean }): Promise<Request>;
  env(base: Env): Env;
}

export async function fakeDiscord(): Promise<FakeDiscord> {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const publicKeyHex = bytesToHex(
    (await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer,
  );

  async function sign(body: string, timestamp = String(Math.floor(Date.now() / 1000))) {
    const sig = await crypto.subtle.sign("Ed25519", pair.privateKey, encoder.encode(timestamp + body));
    return { signature: bytesToHex(sig), timestamp };
  }

  return {
    publicKeyHex,
    sign,
    async request(body, opts = {}) {
      const text = JSON.stringify(body);
      const { signature, timestamp } = await sign(text);
      return new Request("https://orrey.test/interactions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-signature-ed25519": opts.tamper ? flipFirstByte(signature) : signature,
          "x-signature-timestamp": timestamp,
        },
        body: text,
      });
    },
    env(base) {
      return { ...base, DISCORD_PUBLIC_KEY: publicKeyHex };
    },
  };
}
