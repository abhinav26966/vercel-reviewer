import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema.js";

export type Db = ReturnType<typeof createDb>;

export function createDb(databaseUrl?: string) {
  const pool = new pg.Pool({
    connectionString:
      databaseUrl ??
      process.env.DATABASE_URL ??
      "postgres://flowguard:flowguard@localhost:5433/flowguard",
  });
  return drizzle(pool, { schema });
}
