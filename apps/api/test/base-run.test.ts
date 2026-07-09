import { describe, expect, it } from "vitest";
import { pino } from "pino";
import { FlowSpecSchema, RunFlowResultSchema, type FlowSpec, type RunFlowResult } from "@flowguard/schemas";
import { orchestrateBaseRun } from "../src/orchestrator/base-run.js";
import { sweepStuckRuns, type SchedulerDeps } from "../src/orchestrator/scheduler.js";
import type { OrchestratorDeps } from "../src/orchestrator/orchestrate.js";
import { FakeStore, boundProject } from "./fakes.js";

const spec: FlowSpec = FlowSpecSchema.parse({
  specVersion: 3,
  flowId: "flw_rip",
  projectId: "prj_1",
  name: "Buy & Rip",
  startPath: "/shop",
  steps: [
    {
      id: "s1",
      title: "Click Buy Pack",
      timingBaselineKey: "s1",
      action: { type: "click", locators: [{ kind: "testid", value: "buy-pack-btn" }, { kind: "text", value: "Buy Pack" }] },
      settle: { strategy: "navigation", timeoutMs: 15000 },
      postConditions: [],
    },
  ],
});

function result(status: "passed" | "failed", versionish = "fsv_official"): RunFlowResult {
  return RunFlowResultSchema.parse({
    runId: "run_b1",
    flowId: "flw_rip",
    specVersionId: versionish,
    target: "base",
    status,
    failedStepId: status === "failed" ? "s1" : null,
    failureClass: status === "failed" ? "locator_miss" : null,
    steps: [{ id: "s1", durationMs: 500, settleMs: 100, network: [], screenshot: null, assertions: [] }],
    perf: { flowTotalMs: 600, regressions: [] },
    coverage: status === "passed" ? { files: ["src/x.ts"], apiRoutes: ["/api/y"], sourceMapsResolved: true } : null,
  });
}

function harness(opts: {
  officialStatus?: "official" | "quarantined";
  officialResult: "passed" | "failed";
  pending?: boolean;
  pendingResult?: "passed" | "failed";
}) {
  const store = new FakeStore();
  store.projects.push({ ...boundProject, id: "prj_1", vercelProjectId: "prj_v", vercelTokenRef: "sec_tok", vercelBypassSecretRef: null });
  store.deployments.push({ id: "dep_base", projectId: "prj_1", sha: "basesha", url: "https://base.vercel.app", environment: "production", state: "ready", branch: "main" });
  store.runs.push({ id: "run_b1", projectId: "prj_1", kind: "base", state: "planning", prId: null, headSha: "basesha", headDeploymentId: "dep_base", branch: "main" });
  store.flowRows.push({ id: "flw_rip", projectId: "prj_1", name: "Buy & Rip", tier: "standard", persona: null, archived: false });
  store.versionRows.push({
    id: "fsv_official",
    flowId: "flw_rip",
    spec,
    status: opts.officialStatus ?? "official",
    branch: "main",
    source: "recording",
    sourceRecordingId: null,
    compilationReport: null,
  });
  if (opts.pending) {
    store.versionRows.push({
      id: "fsv_pending",
      flowId: "flw_rip",
      spec,
      status: "pending",
      branch: "main",
      source: "baseline_promotion",
      sourceRecordingId: null,
      compilationReport: null,
    });
  }

  const enqueued: string[] = [];
  const deps: OrchestratorDeps = {
    store,
    logger: pino({ level: "silent" }),
    githubApp: { getInstallationOctokit: async () => ({}) as never },
    resolveSecret: async (ref) => `plain:${ref}`,
    makeVercelClient: () => ({ listDeployments: async () => [] }),
    enqueueFlowJob: async (_job, jobId) => void enqueued.push(jobId),
    awaitFlowResult: async (jobId) => {
      if (jobId.includes("warmup")) return result("passed");
      if (jobId.includes("-pending-")) return result(opts.pendingResult ?? "failed", "fsv_pending");
      return result(opts.officialResult);
    },
    removeQueuedJob: async () => {},
    setAbortKey: async () => {},
    artifactLink: (k, l) => `[${l}](${k})`,
    flowJobTimeoutMs: 1000,
  };
  return { deps, store, enqueued };
}

describe("orchestrateBaseRun — reconciliation (doc 05 §5)", () => {
  it("green official → baselines + coverage + result cache refreshed at this sha", async () => {
    const h = harness({ officialResult: "passed" });
    await orchestrateBaseRun(h.deps, "run_b1");

    expect(h.store.runs[0]!.state).toBe("done");
    expect(h.store.perfBaselineRows).toEqual([
      expect.objectContaining({ flowId: "flw_rip", branch: "main", sha: "basesha", stepKey: "s1" }),
    ]);
    expect(h.store.coverageMapRows[0]).toMatchObject({ sha: "basesha", files: ["src/x.ts"] });
    expect(h.store.baseCache.get("fsv_official:basesha")).toBeTruthy();
    expect(h.store.versionRows[0]!.status).toBe("official");
  });

  it("red official → quarantined + base_broken alert", async () => {
    const h = harness({ officialResult: "failed" });
    await orchestrateBaseRun(h.deps, "run_b1");

    expect(h.store.versionRows[0]!.status).toBe("quarantined");
    expect(h.store.versionRows[0]!.compilationReport).toMatchObject({ quarantinedSha: "basesha" });
    expect(h.store.alertRows).toEqual([
      expect.objectContaining({ kind: "base_broken", payload: expect.objectContaining({ flowId: "flw_rip" }) }),
    ]);
  });

  it("green run of a quarantined flow → auto-unquarantine, alert acknowledged", async () => {
    const h = harness({ officialStatus: "quarantined", officialResult: "passed" });
    await h.store.createAlert({ projectId: "prj_1", kind: "base_broken", payload: { flowId: "flw_rip" } });
    await orchestrateBaseRun(h.deps, "run_b1");

    expect(h.store.versionRows[0]!.status).toBe("official");
    expect(h.store.alertRows.find((a) => a.kind === "base_broken")!.acknowledgedAt).toBeTruthy();
    expect(h.store.alertRows.some((a) => a.kind === "base_recovered")).toBe(true);
  });

  it("pending green + official red → PROMOTED, predecessor archived, cache under pending id", async () => {
    const h = harness({ officialResult: "failed", pending: true, pendingResult: "passed" });
    await orchestrateBaseRun(h.deps, "run_b1");

    expect(h.store.versionRows.find((v) => v.id === "fsv_pending")!.status).toBe("official");
    expect(h.store.versionRows.find((v) => v.id === "fsv_official")!.status).toBe("archived");
    expect(h.store.baseCache.get("fsv_pending:basesha")).toBeTruthy();
    // no broken-on-base alert: the failure is explained by the approved change
    expect(h.store.alertRows.filter((a) => a.kind === "base_broken")).toHaveLength(0);
  });

  it("both red → baseline_conflict alert, official quarantined, pending held", async () => {
    const h = harness({ officialResult: "failed", pending: true, pendingResult: "failed" });
    await orchestrateBaseRun(h.deps, "run_b1");

    expect(h.store.versionRows.find((v) => v.id === "fsv_official")!.status).toBe("quarantined");
    expect(h.store.versionRows.find((v) => v.id === "fsv_pending")!.status).toBe("pending");
    expect(h.store.alertRows).toEqual([expect.objectContaining({ kind: "baseline_conflict" })]);
  });

  it("official green + pending red → pending quietly waits (its merge hasn't landed)", async () => {
    const h = harness({ officialResult: "passed", pending: true, pendingResult: "failed" });
    await orchestrateBaseRun(h.deps, "run_b1");

    expect(h.store.versionRows.find((v) => v.id === "fsv_pending")!.status).toBe("pending");
    expect(h.store.versionRows.find((v) => v.id === "fsv_official")!.status).toBe("official");
    expect(h.store.alertRows).toHaveLength(0);
    expect(h.store.perfBaselineRows.length).toBeGreaterThan(0);
  });

  it("newest-wins: an older in-flight base run for the branch is superseded", async () => {
    const h = harness({ officialResult: "passed" });
    h.store.runs.unshift({ id: "run_b0", projectId: "prj_1", kind: "base", state: "executing", prId: null, headSha: "oldsha", headDeploymentId: "dep_base", branch: "main" });
    await orchestrateBaseRun(h.deps, "run_b1");
    expect(h.store.runs.find((r) => r.id === "run_b0")!.state).toBe("cancelled");
  });
});

describe("sweepStuckRuns (doc 06 §6)", () => {
  it("errored + alert for runs stuck past the cutoff", async () => {
    const h = harness({ officialResult: "passed" });
    h.store.stuckRuns = [
      { id: "run_stuck", projectId: "prj_1", kind: "pr", state: "executing", prId: null, headSha: "x", headDeploymentId: null, branch: null },
    ];
    h.store.runs.push(h.store.stuckRuns[0]!);
    const swept = await sweepStuckRuns({ ...h.deps, enqueueBaseRun: async () => {} } as SchedulerDeps);
    expect(swept).toBe(1);
    expect(h.store.runs.find((r) => r.id === "run_stuck")!.state).toBe("errored");
    expect(h.store.alertRows).toEqual([expect.objectContaining({ kind: "stuck_run" })]);
  });
});
