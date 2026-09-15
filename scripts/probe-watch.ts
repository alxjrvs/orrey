/**
 * Measures what `events.watch` actually promises — issue #49.
 *
 * Two things phase 7 assumed and this settles, against the real API.
 *
 * **The channel TTL.** `src/google/watch.ts` renews a channel with less than 48
 * hours left, on the assumption that Google issues about seven days. If the real
 * expiry is shorter, that window is wrong and a channel lapses one night with
 * nothing noticing. The measurement decides the constant, and a case in
 * `test/google-watch.test.ts` pins whatever it says.
 *
 * **`privateExtendedProperty`, repeated.** Google's reference says repeated
 * filters are ANDed; its guide says ORed. #49 names the contradiction. It
 * changes no code today — `syncToken` forbids the filter, which is why
 * `src/google/sync.ts` lists the whole calendar — but the day somebody reaches
 * for it, the answer decides whether their query returns what they think.
 *
 * Run by hand, against the real calendar:
 *
 *   op run --env-file=.env.op -- node --experimental-strip-types scripts/probe-watch.ts
 *
 * It cleans up after itself on every path: the channel is stopped and both
 * events deleted in a `finally`, so an error partway through does not leave a
 * live channel pushing at a URL or two stray events on the calendar.
 *
 * The calendar id comes from the environment like every other Google caller
 * here, so this cannot be pointed at a calendar Orrey does not own. Secrets stay
 * in the environment: this prints statuses, ids and durations.
 *
 * Record the printed summary on #49, and put each answer in `docs/GOTCHAS.md`.
 */
import { CALENDAR_SCOPE, serviceAccountToken } from "../src/google/auth.ts";

const clientEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
const privateKey = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
const calendarId = process.env.GOOGLE_CALENDAR_ID;
const origin = process.env.PUBLIC_ORIGIN;

if (!clientEmail || !privateKey || !calendarId || !origin) {
  console.error(
    "Set GOOGLE_SERVICE_ACCOUNT_EMAIL, GOOGLE_SERVICE_ACCOUNT_KEY, GOOGLE_CALENDAR_ID and PUBLIC_ORIGIN (via op run).",
  );
  process.exit(1);
}

const V3 = "https://www.googleapis.com/calendar/v3";
const API = `${V3}/calendars/${encodeURIComponent(calendarId)}`;
const results: string[] = [];
let failed = false;

function report(step: string, ok: boolean, detail: string) {
  const line = `${ok ? "ok  " : "FAIL"} ${step.padEnd(18)} ${detail}`;
  console.log(line);
  results.push(line);
  if (!ok) failed = true;
}

const t = await serviceAccountToken({ clientEmail, privateKey }, [CALENDAR_SCOPE]);
const token = t.accessToken;
report("token", true, `expires in ${t.expiresAt - Math.floor(Date.now() / 1000)}s`);

async function call(method: string, url: string, body?: unknown) {
  const response = await fetch(url, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text ? (JSON.parse(text) as Record<string, unknown>) : {},
  };
}

const channelId = crypto.randomUUID();
let resourceId: string | undefined;
const eventIds = [`probe-a-${Date.now()}`, `probe-b-${Date.now()}`];

try {
  // --- 1. how long does a channel actually last -----------------------------
  const opened = await call("POST", `${API}/events/watch`, {
    id: channelId,
    type: "web_hook",
    address: `${origin}/google/notifications`,
    token: "probe",
  });

  if (opened.status !== 200) {
    // A 401 here usually means the domain is not verified in the Google console,
    // which is the one prerequisite that lives outside this repo.
    report("watch", false, `${opened.status} ${errorOf(opened.body)}`);
  } else {
    resourceId = opened.body.resourceId as string;
    const expiration = Number(opened.body.expiration);
    const seconds = Math.floor(expiration / 1000) - Math.floor(Date.now() / 1000);
    const days = (seconds / 86_400).toFixed(2);
    report("watch", true, `expiration ${expiration} — ${seconds}s, ${days} days`);
    report(
      "renewal window",
      seconds > 48 * 3600,
      seconds > 48 * 3600
        ? `48h window fits inside a ${days}-day TTL`
        : `TTL is ${days} days — the 48h window in src/google/watch.ts MUST shrink`,
    );
  }

  // --- 2. repeated privateExtendedProperty: AND or OR? ----------------------
  const start = new Date(Date.now() + 30 * 86_400 * 1000);
  const end = new Date(start.getTime() + 3600 * 1000);

  for (const [index, id] of eventIds.entries()) {
    const made = await call("POST", `${API}/events`, {
      id,
      summary: `Orrey — watch probe ${index + 1} (safe to delete)`,
      description: "Inserted by scripts/probe-watch.ts. If you can see this, it forgot to clean up.",
      start: { dateTime: start.toISOString() },
      end: { dateTime: end.toISOString() },
      extendedProperties: { private: { probe: `value-${index + 1}` } },
    });
    report(`insert ${index + 1}`, made.status === 200, `${made.status} ${errorOf(made.body)}`);
  }

  const query = new URLSearchParams();
  query.append("privateExtendedProperty", "probe=value-1");
  query.append("privateExtendedProperty", "probe=value-2");
  const filtered = await call("GET", `${API}/events?${query.toString()}`);
  const items = (filtered.body.items as { id: string }[] | undefined) ?? [];
  const mine = items.filter((item) => eventIds.includes(item.id));

  // Two matches is a union (OR); zero is an intersection (AND), since no single
  // event carries both values. Anything else is a third answer worth reading.
  const verdict =
    mine.length === 2 ? "OR (union)" : mine.length === 0 ? "AND (intersection)" : "neither";
  report(
    "repeated filter",
    filtered.status === 200,
    `${filtered.status} — matched ${mine.length} of 2 → ${verdict}`,
  );
} finally {
  // Cleanup on every path, including the error one: a live channel pushes at a
  // URL until it lapses, and a stray event sits on a calendar people read.
  if (resourceId) {
    const stopped = await call("POST", `${V3}/channels/stop`, { id: channelId, resourceId });
    report("stop channel", stopped.status === 204 || stopped.status === 200, `${stopped.status}`);
  }
  for (const [index, id] of eventIds.entries()) {
    const gone = await call("DELETE", `${API}/events/${id}`);
    report(
      `delete ${index + 1}`,
      gone.status === 204 || gone.status === 404 || gone.status === 410,
      `${gone.status}`,
    );
  }
}

console.log();
console.log(
  failed
    ? "Something did not hold. Read the FAIL lines above, record them on #49, and change the constant they name."
    : "Both questions answered. Paste the lines above on #49 and put each answer in docs/GOTCHAS.md.",
);
process.exit(failed ? 1 : 0);

function errorOf(body: Record<string, unknown>): string {
  const err = body.error as { message?: string } | undefined;
  return err?.message ? `— ${err.message}` : "";
}
