import { drizzle } from "drizzle-orm/d1";
import type { Env } from "../env.ts";
import * as schema from "./schema.ts";

export function db(env: Env) {
  return drizzle(env.DB, { schema });
}

export type Db = ReturnType<typeof db>;
export { schema };
