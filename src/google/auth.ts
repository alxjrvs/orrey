/**
 * Service-account auth for Google Calendar, with nothing but WebCrypto — so the
 * same code runs in the Worker and in a Node script.
 *
 * The pattern: Orrey owns a calendar; the service account is granted `writer`
 * on it (an `acl.insert`, done once by the calendar's owner). The account then
 * signs a JWT with its private key and swaps it for a short-lived access token.
 * There is no refresh token, so there is nothing to expire or re-consent.
 */

const TOKEN_URI = "https://oauth2.googleapis.com/token";
export const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar";

export interface ServiceAccount {
  clientEmail: string;
  /** PKCS#8 PEM. A key pasted through an env var may carry literal `\n`. */
  privateKey: string;
}

export interface AccessToken {
  accessToken: string;
  /** Unix seconds. */
  expiresAt: number;
}

export async function serviceAccountToken(
  account: ServiceAccount,
  scopes: string[] = [CALENDAR_SCOPE],
  now: number = Math.floor(Date.now() / 1000),
): Promise<AccessToken> {
  const assertion = await signJwt(account, scopes, now);

  const response = await fetch(TOKEN_URI, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  if (!response.ok) {
    throw new Error(`token exchange failed: ${response.status} ${await response.text()}`);
  }
  const body = (await response.json()) as { access_token: string; expires_in: number };
  return { accessToken: body.access_token, expiresAt: now + body.expires_in };
}

/** RS256 JWT, the shape Google's token endpoint accepts as an assertion. */
export async function signJwt(
  account: ServiceAccount,
  scopes: string[],
  now: number,
): Promise<string> {
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64url(
    JSON.stringify({
      iss: account.clientEmail,
      scope: scopes.join(" "),
      aud: TOKEN_URI,
      iat: now,
      exp: now + 3600,
    }),
  );
  const signingInput = `${header}.${claims}`;
  const key = await importPrivateKey(account.privateKey);
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${base64url(signature)}`;
}

export function importPrivateKey(pem: string): Promise<CryptoKey> {
  const der = pemToDer(pem);
  return crypto.subtle.importKey(
    "pkcs8",
    der,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

function pemToDer(pem: string): Uint8Array {
  const body = pem
    .replaceAll("\\n", "\n")
    .replace(/-----BEGIN [A-Z ]+-----/, "")
    .replace(/-----END [A-Z ]+-----/, "")
    .replace(/\s+/g, "");
  const binary = atob(body);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function base64url(input: string | ArrayBuffer | Uint8Array): string {
  const bytes =
    typeof input === "string"
      ? new TextEncoder().encode(input)
      : input instanceof Uint8Array
        ? input
        : new Uint8Array(input);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
