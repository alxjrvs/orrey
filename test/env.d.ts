import type { D1Migration } from "@cloudflare/vitest-pool-workers";
import type { Env } from "../src/env.ts";

/**
 * `cloudflare:test` exposes the Worker's bindings as `Cloudflare.Env`. Orrey
 * does not generate `worker-configuration.d.ts`, so the hand-written Env is the
 * shape — plus the migrations the setup file applies.
 */
declare global {
  namespace Cloudflare {
    interface Env extends OrreyEnv {
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}

type OrreyEnv = Env;
