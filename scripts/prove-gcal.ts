/**
 * Proves the service-account calendar pattern by hand — issue #11.
 *
 * The settled Google design rests on something community-established but not
 * documented by Google: an Orrey-owned calendar, a service account granted
 * `writer` on it, and no refresh token anywhere. Phase 1 builds on it, so it is
 * proved here first, end to end, against the real API.
 *
 * Set-up (once, in a browser, as the Orrey Google account):
 *   1. Google Cloud console → new project → APIs & Services → enable "Google
 *      Calendar API" → Credentials → create a service account → Keys → add a
 *      JSON key. Put `client_email` and `private_key` from it in 1Password.
 *   2. Google Calendar → create a calendar "Orrey" → Settings → "Share with
 *      specific people" → add the service account's email with "Make changes to
 *      events". That is `acl.insert` with role `writer`, done by the owner.
 *      Copy the calendar id (…@group.calendar.google.com) to 1Password.
 *
 * Then, with .env.op pointing at those items:
 *
 *   op run --env-file=.env.op -- node --experimental-strip-types scripts/prove-gcal.ts
 *
 * What it does, in order, and what each step proves:
 *   token          the JWT → access-token exchange works with the key alone
 *   insert         the account can write to the shared calendar (it is `writer`)
 *   insert again   the same self-minted id is refused with 409 — the upsert
 *                  rule "insert, then 409 → update" holds
 *   update         the id is addressable for writes
 *   delete         and for deletion; then a get returns the event as cancelled
 *
 * Secrets stay in the environment. This prints statuses and the event id only.
 * Record the printed summary on #11.
 */
import { CALENDAR_SCOPE, serviceAccountToken } from "../src/google/auth.ts";
import { eventIdFor } from "../src/google/event-id.ts";

const clientEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
const privateKey = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
const calendarId = process.env.GOOGLE_CALENDAR_ID;

if (!clientEmail || !privateKey || !calendarId) {
  console.error(
    "Set GOOGLE_SERVICE_ACCOUNT_EMAIL, GOOGLE_SERVICE_ACCOUNT_KEY and GOOGLE_CALENDAR_ID (via op run).",
  );
  process.exit(1);
}

const API = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}`;
const results: string[] = [];
let failed = false;

function report(step: string, ok: boolean, detail: string) {
  const line = `${ok ? "ok  " : "FAIL"} ${step.padEnd(14)} ${detail}`;
  console.log(line);
  results.push(line);
  if (!ok) failed = true;
}

// --- token ------------------------------------------------------------------
let token: string;
try {
  const t = await serviceAccountToken({ clientEmail, privateKey }, [CALENDAR_SCOPE]);
  token = t.accessToken;
  report("token", true, `expires in ${t.expiresAt - Math.floor(Date.now() / 1000)}s`);
} catch (error) {
  report("token", false, String(error));
  finish();
}

async function call(method: string, path: string, body?: unknown) {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
}

// --- the event ----------------------------------------------------------------
const eventId = await eventIdFor(`proof-${Date.now()}`);
const start = new Date(Date.now() + 7 * 24 * 3600 * 1000);
const end = new Date(start.getTime() + 3 * 3600 * 1000);
const event = {
  id: eventId,
  summary: "Orrey — service-account proof (safe to delete)",
  description: "Inserted by scripts/prove-gcal.ts. If you can see this, it forgot to clean up.",
  start: { dateTime: start.toISOString() },
  end: { dateTime: end.toISOString() },
};
console.log(`event id ${eventId}`);

// insert
const inserted = await call("POST", "/events", event);
report("insert", inserted.status === 200, `${inserted.status} ${errorOf(inserted.body)}`);

// insert again: must be 409
const again = await call("POST", "/events", event);
report("insert again", again.status === 409, `${again.status} — expected 409 ${errorOf(again.body)}`);

// update
const updated = await call("PATCH", `/events/${eventId}`, { summary: `${event.summary} — updated` });
report("update", updated.status === 200, `${updated.status} ${errorOf(updated.body)}`);

// delete
const deleted = await call("DELETE", `/events/${eventId}`);
report("delete", deleted.status === 204, `${deleted.status} ${errorOf(deleted.body)}`);

// get after delete: Google keeps a tombstone with status "cancelled"
const after = await call("GET", `/events/${eventId}`);
const cancelled = after.status === 200 && after.body.status === "cancelled";
report("get (deleted)", cancelled || after.status === 404 || after.status === 410, `${after.status} status=${after.body.status ?? "—"}`);

finish();

function errorOf(body: Record<string, unknown>): string {
  const err = body.error as { message?: string } | undefined;
  return err?.message ? `— ${err.message}` : "";
}

function finish(): never {
  console.log();
  if (failed) {
    console.log("The pattern did NOT hold. Do not start phase 1 on it; record this on #11 and pick a fallback.");
    process.exit(1);
  }
  console.log("The service-account + shared-calendar pattern holds. Paste the lines above on #11.");
  process.exit(0);
}
