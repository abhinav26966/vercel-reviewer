import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { getTableName } from "drizzle-orm";
import * as schema from "../src/schema.js";

/** Every table doc 08 defines must exist with its exact SQL name. */
const DOC_08_TABLES = [
  "orgs",
  "users",
  "github_installations",
  "projects",
  "secrets",
  "credential_sets",
  "payment_configs",
  "flows",
  "flow_spec_versions",
  "recordings",
  "coverage_maps",
  "perf_baselines",
  "deployments",
  "pull_requests",
  "runs",
  "run_flow_results",
  "base_result_cache",
  "verdicts",
  "session_states",
  "webhook_deliveries",
  "alerts",
];

describe("db schema", () => {
  it("defines every doc 08 table with matching SQL names", () => {
    const defined = Object.values(schema)
      .filter((v) => typeof v === "object" && v !== null)
      .map((t) => {
        try {
          return getTableName(t as Parameters<typeof getTableName>[0]);
        } catch {
          return null;
        }
      })
      .filter((n): n is string => n !== null);
    for (const table of DOC_08_TABLES) {
      expect(defined, `missing table ${table}`).toContain(table);
    }
    expect(defined.sort()).toEqual([...DOC_08_TABLES].sort());
  });

  it("has committed migrations", () => {
    const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "drizzle");
    const files = readdirSync(dir).filter((f) => f.endsWith(".sql"));
    expect(files.length).toBeGreaterThan(0);
  });
});
