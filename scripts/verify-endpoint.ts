/**
 * Checks a deployed Worker the way Discord will when the Interactions Endpoint
 * URL is saved — as far as that can be done from outside.
 *
 *   node --experimental-strip-types scripts/verify-endpoint.ts https://orrey.<account>.workers.dev
 *
 * What it proves: /healthz answers, and POST /interactions returns 401 for a
 * bad signature and for no signature at all. What it cannot prove: PING → PONG
 * on a *good* signature, because only Discord holds the private key for the
 * application's public key. That half is covered by the tests in workerd
 * (test/interactions.test.ts) and by Discord's own validation on save.
 */
export {};

const base = process.argv[2]?.replace(/\/$/, "");
if (!base) {
  console.error("Usage: verify-endpoint.ts <worker-origin>");
  process.exit(1);
}

let failed = false;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail ? `  (${detail})` : ""}`);
  if (!ok) failed = true;
};

const health = await fetch(`${base}/healthz`);
const healthBody = (await health.json().catch(() => ({}))) as { ok?: boolean; environment?: string };
check("GET /healthz is 200", health.status === 200, `environment=${healthBody.environment}`);

const body = JSON.stringify({ type: 1 });
const timestamp = String(Math.floor(Date.now() / 1000));

const unsigned = await fetch(`${base}/interactions`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body,
});
check("POST /interactions without signature headers is 401", unsigned.status === 401, `${unsigned.status}`);

const badSig = await fetch(`${base}/interactions`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-signature-ed25519": "00".repeat(64),
    "x-signature-timestamp": timestamp,
  },
  body,
});
check("POST /interactions with a bad signature is 401", badSig.status === 401, `${badSig.status}`);

const privacy = await fetch(`${base}/privacy`);
check("GET /privacy serves the policy", privacy.status === 200 && /knows about you/.test(await privacy.text()));

if (failed) {
  console.error("\nNot ready. Do not save the Interactions Endpoint URL yet.");
  process.exit(1);
}
console.log("\nReady for Discord's validation. PING/PONG is Discord's half — save the URL to run it.");
