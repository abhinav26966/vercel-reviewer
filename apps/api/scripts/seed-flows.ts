/**
 * Seed the handwritten Phase 2 specs as `official` flow versions (doc 09 Phase 3
 * task 6). Idempotent: unchanged specs are skipped; changed specs archive the old
 * official version and insert a new one (spec rows are immutable, doc 08).
 *
 * Usage: pnpm exec tsx --env-file=.env scripts/seed-flows.ts [--branch main]
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { parseArgs } from "node:util";
import { and, eq } from "drizzle-orm";
import { createDb, flowSpecVersions, flows } from "@flowguard/db";
import { FlowSpecSchema } from "@flowguard/schemas";
import { newId } from "@flowguard/shared";

const { values: args } = parseArgs({
  options: { branch: { type: "string", default: "main" } },
  allowPositionals: true,
});
const branch = args.branch!;

const db = createDb(process.env.DATABASE_URL);
const flowsDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../runner/flows",
);

// rip-broken is a CLI-only chaos artifact, not a product flow
const SEED_FILES = ["login.flow.json", "inventory.flow.json", "rip.flow.json"];

for (const file of SEED_FILES) {
  const spec = FlowSpecSchema.parse(JSON.parse(await readFile(path.join(flowsDir, file), "utf8")));

  const existingFlow = await db.select().from(flows).where(eq(flows.id, spec.flowId)).limit(1);
  if (!existingFlow[0]) {
    await db.insert(flows).values({
      id: spec.flowId,
      projectId: spec.projectId,
      name: spec.name,
      tier: spec.tier,
      persona: spec.persona,
    });
  } else {
    await db.update(flows).set({ name: spec.name, tier: spec.tier }).where(eq(flows.id, spec.flowId));
  }

  const official = await db
    .select()
    .from(flowSpecVersions)
    .where(
      and(
        eq(flowSpecVersions.flowId, spec.flowId),
        eq(flowSpecVersions.branch, branch),
        eq(flowSpecVersions.status, "official"),
      ),
    )
    .limit(1);

  if (official[0] && JSON.stringify(official[0].spec) === JSON.stringify(spec)) {
    console.log(`${spec.flowId}: official version unchanged — skipped`);
    continue;
  }

  if (official[0]) {
    await db
      .update(flowSpecVersions)
      .set({ status: "archived" })
      .where(eq(flowSpecVersions.id, official[0].id));
  }

  const versionId = newId("flowSpecVersion");
  await db.insert(flowSpecVersions).values({
    id: versionId,
    flowId: spec.flowId,
    spec,
    status: "official",
    branch,
    source: "plain_language", // handwritten (doc 08 source enum)
    supersedesVersionId: official[0]?.id ?? null,
  });
  console.log(`${spec.flowId}: seeded official version ${versionId} (${spec.name})`);
}
process.exit(0);
