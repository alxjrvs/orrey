import { describe, expect, it } from "vitest";
import { CALENDAR_SCOPE, base64url, signJwt } from "../src/google/auth.ts";
import { eventIdFor, isValidEventId } from "../src/google/event-id.ts";

async function testKey() {
  const pair = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const pkcs8 = (await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer;
  const b64 = btoa(String.fromCharCode(...new Uint8Array(pkcs8))).replace(/(.{64})/g, "$1\n");
  const pem = `-----BEGIN PRIVATE KEY-----\n${b64}\n-----END PRIVATE KEY-----\n`;
  return { pem, publicKey: pair.publicKey };
}

function decode(segment: string): Record<string, unknown> {
  const b64 = segment.replaceAll("-", "+").replaceAll("_", "/");
  return JSON.parse(atob(b64)) as Record<string, unknown>;
}

describe("service-account JWT", () => {
  it("is RS256 over the claims Google expects, verifiable with the public key", async () => {
    const { pem, publicKey } = await testKey();
    const now = 1_800_000_000;
    const jwt = await signJwt({ clientEmail: "orrey@example.iam.gserviceaccount.com", privateKey: pem }, [CALENDAR_SCOPE], now);

    const [header, claims, signature] = jwt.split(".") as [string, string, string];
    expect(decode(header)).toEqual({ alg: "RS256", typ: "JWT" });
    expect(decode(claims)).toEqual({
      iss: "orrey@example.iam.gserviceaccount.com",
      scope: CALENDAR_SCOPE,
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600,
    });

    const sigBytes = Uint8Array.from(atob(signature.replaceAll("-", "+").replaceAll("_", "/")), (c) => c.charCodeAt(0));
    const valid = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      publicKey,
      sigBytes,
      new TextEncoder().encode(`${header}.${claims}`),
    );
    expect(valid).toBe(true);
  });

  it("accepts a key whose newlines were flattened to literal \\n by an env var", async () => {
    const { pem } = await testKey();
    const flattened = pem.replaceAll("\n", "\\n");
    await expect(signJwt({ clientEmail: "x@y", privateKey: flattened }, [CALENDAR_SCOPE], 0)).resolves.toMatch(/^[\w-]+\.[\w-]+\.[\w-]+$/);
  });

  it("base64url has no padding and no +/", () => {
    expect(base64url(new Uint8Array([251, 255, 254]))).toBe("-__-");
    expect(base64url("a")).toBe("YQ");
  });
});

describe("event ids", () => {
  it("are deterministic per session and within Google's base32hex alphabet", async () => {
    const a = await eventIdFor("session-1");
    const b = await eventIdFor("session-1");
    const c = await eventIdFor("session-2");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toHaveLength(32);
    expect(isValidEventId(a)).toBe(true);
  });

  it("rejects what Google rejects", () => {
    expect(isValidEventId("abcd")).toBe(false); // too short
    expect(isValidEventId("has-hyphen")).toBe(false);
    expect(isValidEventId("UPPER0")).toBe(false);
    expect(isValidEventId("wxyz0")).toBe(false); // w–z are outside base32hex
    expect(isValidEventId("0123456789abcdefghijklmnopqrstuv")).toBe(true);
  });
});
