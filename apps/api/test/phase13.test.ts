import { describe, expect, it } from "vitest";
import { pino } from "pino";
import { resolveProjectInference } from "../src/inference-resolver.js";
import { FakeStore } from "./fakes.js";
import type { Store } from "../src/store.js";
import type { InferenceProvider } from "@flowguard/inference";

const platform = {
  visionAnalyze: async () => ({ result: { answer: "platform", confidence: 1 } as never, usage: { model: "platform-free", promptTokens: 0, completionTokens: 0 } }),
  groundElement: async () => ({ result: null, usage: { model: "platform-free", promptTokens: 0, completionTokens: 0 } }),
  judge: async () => ({ result: {} as never, usage: { model: "platform-free", promptTokens: 0, completionTokens: 0 } }),
} as InferenceProvider;

describe("BYO inference resolver (doc 09 Phase 13)", () => {
  it("no project key → the platform provider (zero-config default)", async () => {
    const store = new FakeStore();
    const p = await resolveProjectInference({ projectId: "prj_1", settings: {}, store: store as unknown as Store, resolveSecret: async () => "x", platform });
    expect(p).toBe(platform);
  });

  it("a broken key falls back to platform (never takes the project offline)", async () => {
    const store = new FakeStore();
    const p = await resolveProjectInference({
      projectId: "prj_1",
      settings: { inference: { keyRef: "sec_bad" } },
      store: store as unknown as Store,
      resolveSecret: async () => { throw new Error("vault miss"); },
      platform,
    });
    expect(p).toBe(platform);
  });

  it("a valid key builds a project provider distinct from the platform's", async () => {
    const store = new FakeStore();
    const p = await resolveProjectInference({
      projectId: "prj_1",
      settings: { inference: { keyRef: "sec_ok", judgeModels: ["anthropic/claude-haiku-4.5"] } },
      store: store as unknown as Store,
      resolveSecret: async () => "sk-real",
      platform,
    });
    expect(p).not.toBe(platform);
  });
});

describe("FakeStore Phase-13 aggregates", () => {
  it("usage aggregates by kind → runs, runner-ms, tokens", async () => {
    const store = new FakeStore();
    await store.recordUsage({ projectId: "prj_1", kind: "run", amount: 1 });
    await store.recordUsage({ projectId: "prj_1", kind: "runner_ms", amount: 5000 });
    await store.recordUsage({ projectId: "prj_1", kind: "runner_ms", amount: 3000 });
    await store.recordUsage({ projectId: "prj_1", kind: "inference_tokens", amount: 420, model: "claude" });
    const u = await store.aggregateUsage("prj_1", new Date(0));
    expect(u).toEqual({ runs: 1, runnerMs: 8000, inferenceTokens: 420 });
  });

  it("verdict report resolves projectId via the run and lists per project", async () => {
    const store = new FakeStore();
    store.runs.push({ id: "run_1", projectId: "prj_1", kind: "pr", state: "done", prId: null, headSha: "x", headDeploymentId: null, branch: null });
    const vid = await store.insertVerdict({ runId: "run_1", flowId: "flw_1", verdict: "broken", humanCopy: "x", evidence: {} });
    const r = await store.createVerdictReport({ verdictId: vid, reason: "actually intended", reportedBy: "dev" });
    expect(r).not.toBeNull();
    const reports = await store.listVerdictReports("prj_1");
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ verdictId: vid, reportedVerdict: "broken", reason: "actually intended" });
  });

  it("reporting an unknown verdict returns null", async () => {
    const store = new FakeStore();
    expect(await store.createVerdictReport({ verdictId: "vrd_missing", reason: null, reportedBy: null })).toBeNull();
  });

  it("onboarding status reflects setup progress", async () => {
    const store = new FakeStore();
    store.projects.push({ id: "prj_1", name: "p", githubRepo: "o/r", installationId: 5, vercelProjectId: "prj_v", vercelTeamId: null, vercelTokenRef: "sec_t", vercelBypassSecretRef: null, baseBranches: ["main"] });
    let s = await store.onboardingStatus("prj_1");
    expect(s).toMatchObject({ githubInstalled: true, vercelBound: true, credentialsSet: false, firstFlowRecorded: false, firstRunCompleted: false });
    store.officialFlows.push({ flowId: "flw_1", flowName: "Login", tier: "smoke", specVersionId: "fsv_1", spec: {} as never, branch: "main", projectId: "prj_1" });
    store.runs.push({ id: "run_1", projectId: "prj_1", kind: "pr", state: "done", prId: null, headSha: "x", headDeploymentId: null, branch: null });
    s = await store.onboardingStatus("prj_1");
    expect(s).toMatchObject({ firstFlowRecorded: true, firstRunCompleted: true });
  });

  it("per-project active-run count excludes terminal states", async () => {
    const store = new FakeStore();
    store.runs.push({ id: "r1", projectId: "prj_1", kind: "pr", state: "executing", prId: null, headSha: "x", headDeploymentId: null, branch: null });
    store.runs.push({ id: "r2", projectId: "prj_1", kind: "pr", state: "done", prId: null, headSha: "y", headDeploymentId: null, branch: null });
    store.runs.push({ id: "r3", projectId: "prj_2", kind: "pr", state: "planning", prId: null, headSha: "z", headDeploymentId: null, branch: null });
    expect(await store.countActiveRunsForProject("prj_1")).toBe(1);
  });
});

void pino;
