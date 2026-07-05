import { migrate } from "drizzle-orm/node-postgres/migrator";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { fileURLToPath } from "node:url";
import path from "node:path";

const url =
  process.env.DATABASE_URL ?? "postgres://flowguard:flowguard@localhost:5433/flowguard";

const migrationsFolder = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "drizzle",
);

const pool = new pg.Pool({ connectionString: url });
const db = drizzle(pool);

try {
  await migrate(db, { migrationsFolder });
  console.log("migrations applied");
} finally {
  await pool.end();
}
