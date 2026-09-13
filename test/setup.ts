import { applyD1Migrations, env } from "cloudflare:test";

// Each test file gets an isolated D1; bring it up to the current schema.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
