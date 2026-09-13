/**
 * A content fingerprint is what makes an outbound projection skippable: the
 * queue may deliver the same message many times, and a write to Discord or
 * Google that changes nothing is still a write — a rate-limit slot spent, and
 * in Google's case an `updated` timestamp that phase 7's return path would have
 * to tell apart from a human's edit.
 *
 * So: hash the content Orrey intends the remote object to have, store the hash
 * next to the id it wrote, and skip when they match.
 */
export async function fingerprint(content: unknown): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical(content)));
  return [...new Uint8Array(digest)]
    .slice(0, 16)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * JSON with object keys sorted, so that two equal contents hash the same
 * however they were built. Undefined and null are the same absence here — a
 * field Orrey does not set and a field it sets to nothing project identically.
 */
function canonical(value: unknown): string {
  if (value === undefined || value === null) return "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined && v !== null)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}
