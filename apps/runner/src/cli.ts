/**
 * Local iteration CLI (doc 09 Phase 2 task 4):
 *   pnpm --filter @flowguard/runner flow:run <spec.json> <deploymentUrl> [--no-upload] [--headed]
 * Bypass secret via VERCEL_BYPASS env var (protected previews).
 */
import { readFile } from "node:fs/promises";
import { ExecuteFlowJobSchema, FlowSpecSchema } from "@flowguard/schemas";
import { createLogger, newId } from "@flowguard/shared";
import { NullArtifactStore, S3ArtifactStore } from "./artifacts.js";
import { loadRunnerEnv } from "./config.js";
import { executeFlow } from "./execute-flow.js";
import { VaultSecretResolver } from "./secrets.js";

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith("--")));
const [specPath, deploymentUrl] = args.filter((a) => !a.startsWith("--"));

if (!specPath || !deploymentUrl) {
  console.error("usage: flow:run <spec.json> <deploymentUrl> [--no-upload] [--headed]");
  process.exit(2);
}

const env = loadRunnerEnv();
const logger = createLogger({ name: "runner-cli", level: env.LOG_LEVEL });
const spec = FlowSpecSchema.parse(JSON.parse(await readFile(specPath, "utf8")));

const job = ExecuteFlowJobSchema.parse({
  runId: newId("run"),
  flowId: spec.flowId,
  specVersionId: "fsv_local",
  spec,
  target: {
    kind: "head",
    deploymentUrl,
    bypassSecret: process.env.VERCEL_BYPASS ?? null,
    sha: "local",
  },
  configBundle: { persona: null, payment: null, dataBranchDiffers: false },
  mode: "validate",
  collect: { coverage: false, har: true, video: true },
  abortToken: null,
});

const artifacts = flags.has("--no-upload") ? new NullArtifactStore() : new S3ArtifactStore(env);
const result = await executeFlow({
  job,
  logger,
  artifacts,
  headless: !flags.has("--headed"),
  // vault access is optional for CLI runs of secretless specs
  ...(process.env.FLOWGUARD_MASTER_KEY ? { secretResolver: new VaultSecretResolver() } : {}),
});

console.log(JSON.stringify(result, null, 2));
console.error(
  `\n${result.status === "passed" ? "✅" : "🔴"} ${spec.name}: ${result.status}` +
    (result.failedStepId ? ` at step ${result.failedStepId} (${result.failureClass})` : "") +
    ` in ${result.perf.flowTotalMs}ms`,
);
process.exit(result.status === "passed" ? 0 : 1);
