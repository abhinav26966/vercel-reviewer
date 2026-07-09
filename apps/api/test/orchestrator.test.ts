import { describe, expect, it } from "vitest";
import { pino } from "pino";
import { FlowSpecSchema, RunFlowResultSchema, type FlowSpec, type RunFlowResult } from "@flowguard/schemas";
import { STICKY_MARKER } from "@flowguard/github";
import { orchestrateRun, type OrchestratorDeps } from "../src/orchestrator/orchestrate.js";
import { compareFlow } from "../src/orchestrator/comparator.js";
import { FakeStore, boundProject, fakeOctokit } from "./fakes.js";

// ── builders ──────────────────────────────────────────────────────────────
const spec: FlowSpec = FlowSpecSchema.parse({
  specVersion: 3,
  flowId: "flw_rip",
  projectId: "prj_1",
  name: "Rip",
  startPath: "/open",
  steps: [
    {
      id: "s6",
      title: "Rip open the pack",
      action: {
        type: "click",
        locators: [
          { kind: "testid", value: "pack-canvas" },
          { kind: "css", value: "canvas" },
        ],
      },
      settle: { strategy: "networkidle", timeoutMs: 5000 },
      postConditions: [
        { kind: "dom", assert: "hidden", locators: [{ kind: "testid", value: "open-error" }] },
      ],
    },
  ],
});

function result(target: "head" | "base", status: "passed" | "failed" | "error", extras: Partial<RunFlowResult> = {}): RunFlowResult {
  return RunFlowResultSchema.parse({
    runId: "run_x",
    flowId: "flw_rip",
    specVersionId: "fsv_1",
    target,
    status,
    failedStepId: status === "failed" ? "s6" : null,
    failureClass: status === "failed" ? "assertion" : status === "error" ? "env" : null,
    steps:
      status === "failed"
        ? [
            {
              id: "s6",
              durationMs: 5000,
              settleMs: 0,
              network: [
                { method: "POST", url: "https://x/api/packs/open", status: 500, ttfbMs: 80, totalMs: 120, resourceType: "fetch" },
              ],
              screenshot: "runs/run_x/flw_rip/head/steps/s6/failure.png",
              assertions: [{ kind: "dom", pass: false, message: 'text "1" !~ /^0$/' }],
            },
          ]
        : [],
    perf: { flowTotalMs: 6100, regressions: [] },
    artifacts: {
      video: `runs/run_x/flw_rip/${target}/video.webm`,
      trace: `runs/run_x/flw_rip/${target}/trace.zip`,
      har: null,
      console: null,
      coverage: null,
    },
    ...extras,
  });
}

const link = (key: string, label: string) => `[${label}](https://api.local/artifacts?key=${key})`;

interface Harness {
  deps: OrchestratorDeps;
  store: FakeStore;
  octo: ReturnType<typeof fakeOctokit>;
  enqueued: string[];
  aborted: string[];
}

function makeHarness(opts: {
  headResults?: Record<string, RunFlowResult>;
  baseResults?: Record<string, RunFlowResult>;
  baseDeploymentAvailable?: boolean;
  flows?: Array<{ flowId: string; flowName: string; specVersionId: string; tier?: string }>;
  /** changed files reported by the compare API (default: no diff info → cold start). */
  changedFiles?: string[];
}): Harness {
  const store = new FakeStore();
  store.projects.push({ ...boundProject, id: "prj_1", vercelProjectId: "prj_v", vercelTokenRef: "sec_tok", vercelBypassSecretRef: "sec_byp" });
  store.pullRequests.push({ id: "pull_1", projectId: "prj_1", number: 7, state: "open", baseBranch: "main", stickyCommentId: null });
  store.deployments.push({ id: "dep_head", projectId: "prj_1", sha: "headsha", url: "https://head.vercel.app", environment: "preview", state: "ready", branch: "feat" });
  store.runs.push({ id: "run_1", projectId: "prj_1", kind: "pr", state: "planning", prId: "pull_1", headSha: "headsha", headDeploymentId: "dep_head", branch: null });
  for (const f of opts.flows ?? [{ flowId: "flw_rip", flowName: "Rip", specVersionId: "fsv_1" }]) {
    store.officialFlows.push({ tier: "standard", ...f, spec: { ...spec, flowId: f.flowId }, branch: "main", projectId: "prj_1" });
  }

  const octo = fakeOctokit({ openPrs: [], branchContains: { main: ["mergebase"] } });
  // compare API for merge base + changed files (selection input)
  (octo.octokit.rest.repos as unknown as Record<string, unknown>)["compareCommitsWithBasehead"] = async () => ({
    data: {
      status: "diverged",
      merge_base_commit: { sha: "mergebase" },
      files: (opts.changedFiles ?? []).map((filename) => ({ filename })),
    },
  });

  const enqueued: string[] = [];
  const aborted: string[] = [];
  const deps: OrchestratorDeps = {
    store,
    logger: pino({ level: "silent" }),
    githubApp: { getInstallationOctokit: async () => octo.octokit as never },
    resolveSecret: async (ref) => `plain:${ref}`,
    makeVercelClient: () => ({
      listDeployments: async ({ sha }) =>
        opts.baseDeploymentAvailable === false
          ? []
          : sha === "mergebase"
            ? [{ uid: "dpl_base", url: "base.vercel.app", state: "READY", sha: "mergebase" }]
            : [],
    }),
    enqueueFlowJob: async (_job, jobId) => void enqueued.push(jobId),
    awaitFlowResult: async (jobId) => {
      // ids: <runId>-warmup-<target> | <runId>-<flowId>-<target>-m<N>
      const parts = jobId.split("-");
      if (parts[1] === "warmup") {
        return opts.headResults ? Object.values(opts.headResults)[0]! : ({} as RunFlowResult);
      }
      const sample = parts.at(-1);
      const target = sample?.startsWith("m") ? parts.at(-2) : sample;
      const flowId = parts.slice(1, sample?.startsWith("m") ? -2 : -1).join("-");
      const table = target === "head" ? opts.headResults : opts.baseResults;
      const r = table?.[flowId!];
      if (!r) throw new Error(`no scripted result for ${jobId}`);
      return r;
    },
    removeQueuedJob: async () => {},
    setAbortKey: async (runId) => void aborted.push(runId),
    artifactLink: link,
    flowJobTimeoutMs: 1000,
  };
  return { deps, store, octo, enqueued, aborted };
}

// ── comparator (pure) ─────────────────────────────────────────────────────
describe("compareFlow", () => {
  it("head pass → passing", () => {
    const c = compareFlow({ spec, head: result("head", "passed"), base: result("base", "passed"), baseAvailable: true, link });
    expect(c.verdict).toBe("passing");
  });

  it("head fail + base pass → broken, naming step, cause, 5xx, and links", () => {
    const c = compareFlow({ spec, head: result("head", "failed"), base: result("base", "passed"), baseAvailable: true, link });
    expect(c.verdict).toBe("broken");
    expect(c.detail).toContain('step s6 "Rip open the pack"');
    expect(c.detail).toContain('text "1" !~ /^0$/');
    expect(c.detail).toContain("POST /api/packs/open` → 500");
    expect(c.detail).toContain("[video]");
    expect(c.detail).toContain("[screenshot]");
  });

  it("both fail → already_broken_on_base (never blame the PR)", () => {
    const c = compareFlow({ spec, head: result("head", "failed"), base: result("base", "failed"), baseAvailable: true, link });
    expect(c.verdict).toBe("already_broken_on_base");
  });

  it("head fail + no base comparison → env_issue, not broken", () => {
    const c = compareFlow({ spec, head: result("head", "failed"), base: null, baseAvailable: false, link });
    expect(c.verdict).toBe("env_issue");
  });

  it("head env error → env_issue regardless of base", () => {
    const c = compareFlow({ spec, head: result("head", "error"), base: result("base", "passed"), baseAvailable: true, link });
    expect(c.verdict).toBe("env_issue");
  });
});

// ── orchestration ─────────────────────────────────────────────────────────
describe("orchestrateRun", () => {
  it("happy path: head+base jobs, ✅ verdict, table comment, success status, cache write, done", async () => {
    const h = makeHarness({
      headResults: { flw_rip: result("head", "passed") },
      baseResults: { flw_rip: result("base", "passed") },
    });
    await orchestrateRun(h.deps, "run_1");

    expect(h.enqueued).toEqual([
      "run_1-warmup-head",
      "run_1-warmup-base",
      "run_1-flw_rip-head-m1",
      "run_1-flw_rip-head-m2",
      "run_1-flw_rip-base-m1",
      "run_1-flw_rip-base-m2",
    ]);
    expect(h.store.runs[0]!.state).toBe("done");
    expect(h.store.verdicts).toEqual([
      expect.objectContaining({ verdict: "passing", flowId: "flw_rip" }),
    ]);
    expect(h.store.baseCache.size).toBe(1);
    const comment = h.octo.comments[0]!.body;
    expect(comment).toContain(STICKY_MARKER);
    expect(comment).toContain("| Rip | ✅ passing |");
    expect(comment).toContain("`main` @ `mergeba` (merge base)");
    const finalStatus = h.octo.statuses.at(-1)!;
    expect(finalStatus).toMatchObject({ state: "success" });
  });

  it("head fail + base pass → 🔴 row with step+video and a failing status check", async () => {
    const h = makeHarness({
      headResults: { flw_rip: result("head", "failed") },
      baseResults: { flw_rip: result("base", "passed") },
    });
    await orchestrateRun(h.deps, "run_1");

    const comment = h.octo.comments[0]!.body;
    expect(comment).toContain("🔴 broken");
    expect(comment).toContain('step s6 "Rip open the pack"');
    expect(comment).toContain("[video]");
    expect(h.octo.statuses.at(-1)).toMatchObject({ state: "failure" });
    expect(h.store.verdicts[0]!.verdict).toBe("broken");
  });

  it("both fail → ⬜ and a green status check", async () => {
    const h = makeHarness({
      headResults: { flw_rip: result("head", "failed") },
      baseResults: { flw_rip: result("base", "failed") },
    });
    await orchestrateRun(h.deps, "run_1");
    expect(h.octo.comments[0]!.body).toContain("⬜ already broken on base");
    expect(h.octo.statuses.at(-1)).toMatchObject({ state: "success" });
  });

  it("base unresolvable → head-only run, env_issue on failures", async () => {
    const h = makeHarness({
      headResults: { flw_rip: result("head", "failed") },
      baseDeploymentAvailable: false,
    });
    await orchestrateRun(h.deps, "run_1");
    expect(h.enqueued.filter((j) => j.includes("-base"))).toHaveLength(0); // no base jobs
    expect(h.octo.comments[0]!.body).toContain("Base comparison unavailable");
    expect(h.store.verdicts[0]!.verdict).toBe("env_issue");
  });

  it("base cache hit → base job NOT enqueued, result copied with from_cache", async () => {
    const h = makeHarness({
      headResults: { flw_rip: result("head", "passed") },
      changedFiles: ["src/rip.ts"],
    });
    // coverage exists (else the seeding rule forces a base re-run) and covers the diff
    h.store.coverageMapRows.push({ flowId: "flw_rip", branch: "main", sha: "mergebase", files: ["src/rip.ts"], apiRoutes: [] });
    // pre-warm the cache
    const cachedId = await h.store.insertRunFlowResult({
      runId: "run_0",
      flowId: "flw_rip",
      specVersionId: "fsv_1",
      target: "base",
      result: result("base", "passed"),
      fromCache: false,
    });
    await h.store.upsertBaseCache("fsv_1", "mergebase", cachedId);

    await orchestrateRun(h.deps, "run_1");

    expect(h.enqueued.filter((j) => j.includes("-base-m"))).toHaveLength(0);
    const copied = h.store.runFlowResults.filter((r) => r.runId === "run_1" && r.target === "base");
    expect(copied).toHaveLength(1);
    expect(copied[0]!.fromCache).toBe(true);
    expect(h.octo.comments[0]!.body).toContain("base cache hit 1/1");
  });

  it("supersedes older in-flight runs: cancelled, abort key set, superseded_by recorded", async () => {
    const h = makeHarness({
      headResults: { flw_rip: result("head", "passed") },
      baseResults: { flw_rip: result("base", "passed") },
    });
    // created BEFORE run_1 (array order = creation order in the fake)
    h.store.runs.unshift({
      id: "run_0",
      projectId: "prj_1",
      kind: "pr",
      state: "executing",
      prId: "pull_1",
      headSha: "oldsha",
      headDeploymentId: "dep_old",
      branch: null,
    });

    await orchestrateRun(h.deps, "run_1");

    const old = h.store.runs.find((r) => r.id === "run_0")!;
    expect(old.state).toBe("cancelled");
    expect((old as { supersededBy?: string }).supersededBy).toBe("run_1");
    expect(h.aborted).toEqual(["run_0"]);
  });

  it("a run superseded mid-flight does not report", async () => {
    const h = makeHarness({
      headResults: { flw_rip: result("head", "passed") },
      baseResults: { flw_rip: result("base", "passed") },
    });
    // simulate a newer run cancelling us while jobs execute
    const origAwait = h.deps.awaitFlowResult;
    h.deps.awaitFlowResult = async (jobId, t) => {
      await h.store.markSuperseded("run_1", "run_2");
      return origAwait(jobId, t);
    };
    await orchestrateRun(h.deps, "run_1");
    expect(h.octo.comments).toHaveLength(0);
    expect(h.store.runs.find((r) => r.id === "run_1")!.state).toBe("cancelled");
  });

  it("no flows configured → hello comment + success status, run done", async () => {
    const h = makeHarness({ flows: [] });
    h.store.officialFlows = [];
    await orchestrateRun(h.deps, "run_1");
    expect(h.octo.comments[0]!.body).toContain("No flows configured yet");
    expect(h.octo.statuses.at(-1)).toMatchObject({ state: "success" });
    expect(h.store.runs[0]!.state).toBe("done");
  });

  it("skips runs that are not in planning (idempotent re-delivery)", async () => {
    const h = makeHarness({
      headResults: { flw_rip: result("head", "passed") },
      baseResults: { flw_rip: result("base", "passed") },
    });
    h.store.runs[0]!.state = "done";
    await orchestrateRun(h.deps, "run_1");
    expect(h.enqueued).toHaveLength(0);
  });
});

// ── Phase 4: persona wiring ────────────────────────────────────────────────
describe("orchestrateRun — credentials & personas", () => {
  const personaSpec: FlowSpec = FlowSpecSchema.parse({
    specVersion: 3,
    flowId: "flw_inventory",
    projectId: "prj_1",
    name: "Inventory",
    persona: "default",
    startPath: "/inventory",
    steps: [
      {
        id: "s1",
        title: "nav",
        action: { type: "navigate", path: "/inventory" },
        settle: { strategy: "networkidle", timeoutMs: 5000 },
      },
    ],
  });

  function personaHarness(withCreds: boolean) {
    const h = makeHarness({
      headResults: { flw_inventory: { ...result("head", "passed"), flowId: "flw_inventory" } },
      baseResults: { flw_inventory: { ...result("base", "passed"), flowId: "flw_inventory" } },
      flows: [],
    });
    h.store.officialFlows.push({
      flowId: "flw_inventory",
      flowName: "Inventory",
      tier: "standard",
      specVersionId: "fsv_inv",
      spec: personaSpec,
      branch: "main",
      projectId: "prj_1",
    });
    if (withCreds) {
      h.store.credentialSets.push({
        id: "crd_1",
        projectId: "prj_1",
        scope: "project",
        prNumber: null,
        persona: "default",
        usernameSecretId: "sec_u",
        passwordSecretId: "sec_p",
        dataBranchDiffers: false,
        expiresAt: null,
      });
    }
    const jobs: Array<{ jobId: string; bundle: unknown }> = [];
    const orig = h.deps.enqueueFlowJob;
    h.deps.enqueueFlowJob = async (job, jobId) => {
      jobs.push({ jobId, bundle: job.configBundle });
      await orig(job, jobId);
    };
    h.deps.dashboardUrl = "http://localhost:3100";
    return { ...h, jobs };
  }

  it("resolves persona credentials into the job's configBundle", async () => {
    const h = personaHarness(true);
    await orchestrateRun(h.deps, "run_1");
    expect(h.jobs.length).toBeGreaterThan(0);
    const headBundle = h.jobs.find((j) => j.jobId.endsWith("-head-m1"))!.bundle as {
      persona: { name: string; usernameRef: string } | null;
      secretRefs: Record<string, string>;
    };
    expect(headBundle.persona?.name).toBe("default");
    expect(headBundle.persona?.usernameRef).toBe("sec_u");
    expect(headBundle.secretRefs["default.password"]).toBe("sec_p");
    expect(h.store.verdicts[0]!.verdict).toBe("passing");
  });

  it("missing credentials → flow not executed, 🟣 env_issue with the credentials link", async () => {
    const h = personaHarness(false);
    await orchestrateRun(h.deps, "run_1");
    expect(h.jobs).toHaveLength(0); // nothing enqueued for either target
    expect(h.store.verdicts[0]!.verdict).toBe("env_issue");
    const comment = h.octo.comments[0]!.body;
    expect(comment).toContain("🟣 env issue");
    expect(comment).toContain("PR-scoped credentials");
    expect(comment).toContain("/flowguard rerun");
    expect(comment).toContain("http://localhost:3100/projects/prj_1?pr=7");
  });
});

// ── Phase 10: quarantined flows on PRs ─────────────────────────────────────
describe("orchestrateRun — quarantine (doc 05 §5.3)", () => {
  it("quarantined flow renders ⬜ without executing; healthy flows run normally", async () => {
    const h = makeHarness({
      headResults: { flw_rip: result("head", "passed") },
      baseResults: { flw_rip: result("base", "passed") },
      changedFiles: ["anything.ts"],
    });
    h.store.flowRows.push({ id: "flw_quar", projectId: "prj_1", name: "Quarantined Flow", tier: "standard", persona: null, archived: false });
    h.store.versionRows.push({
      id: "fsv_q",
      flowId: "flw_quar",
      spec: { ...spec, flowId: "flw_quar" },
      status: "quarantined",
      branch: "main",
      source: "recording",
      sourceRecordingId: null,
      compilationReport: { quarantinedSha: "deadbeef123" },
    });

    await orchestrateRun(h.deps, "run_1");

    expect(h.enqueued.filter((j) => j.includes("flw_quar"))).toHaveLength(0);
    const comment = h.octo.comments[0]!.body;
    expect(comment).toContain("| Quarantined Flow | ⬜ already broken on base |");
    expect(comment).toContain("quarantined — broken on main since `deadbee`");
    expect(comment).toContain("| Rip | ✅ passing |");
    expect(h.octo.statuses.at(-1)).toMatchObject({ state: "success" });
  });
});

// ── Phase 9: the intent judge in the run loop ──────────────────────────────
describe("orchestrateRun — intent judge", () => {
  const blueOutput = {
    outcome: "changed_as_intended",
    confidence: 0.9,
    rationale: "PR describes renaming the CTA and the diff touches the shop page.",
    humanCopy: "matches PR intent to rename the shop CTA",
  };

  function judgeHarness(opts: { changedFiles: string[]; modelOutcome?: string }) {
    const h = makeHarness({
      headResults: { flw_rip: result("head", "failed") },
      baseResults: { flw_rip: result("base", "passed") },
      changedFiles: opts.changedFiles,
    });
    // coverage exists so selection + correlation have something to intersect
    h.store.coverageMapRows.push({
      flowId: "flw_rip",
      branch: "main",
      sha: "old",
      files: ["src/rip.ts", "src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"],
      apiRoutes: [],
    });
    const judgeCalls: string[] = [];
    h.deps.inference = {
      judge: async ({ prompt }: { prompt: string }) => {
        judgeCalls.push(prompt);
        return { result: { ...blueOutput, outcome: opts.modelOutcome ?? "changed_as_intended" } as never };
      },
    } as never;
    h.deps.dashboardUrl = "http://localhost:3100";
    return { ...h, judgeCalls };
  }

  it("broken + correlated diff + model says intended → 🔵 with approval link, pending status", async () => {
    const h = judgeHarness({ changedFiles: ["src/rip.ts"] });
    await orchestrateRun(h.deps, "run_1");

    expect(h.store.verdicts[0]!.verdict).toBe("changed_as_intended");
    expect(h.store.verdicts[0]!.approvalState).toBe("awaiting");
    const comment = h.octo.comments[0]!.body;
    expect(comment).toContain("🔵 changed as intended");
    expect(comment).toContain("review & approve");
    expect(h.octo.statuses.at(-1)).toMatchObject({ state: "pending" });
    // the prompt quarantined the PR text as untrusted
    expect(h.judgeCalls[0]).toContain("UNTRUSTED author-controlled data");
  });

  it("broken + UNRELATED diff → stays 🔴 even when the model says intended (code mirror)", async () => {
    const h = judgeHarness({ changedFiles: ["src/lib/dates.ts"] });
    // selection would skip an uncorrelated flow — force it through the smoke tier
    h.store.officialFlows[0]!.tier = "smoke";
    await orchestrateRun(h.deps, "run_1");

    expect(h.store.verdicts[0]!.verdict).toBe("broken");
    expect(h.octo.statuses.at(-1)).toMatchObject({ state: "failure" });
  });

  it("model says regression → 🔴; judge absent → 🔴", async () => {
    const h = judgeHarness({ changedFiles: ["src/rip.ts"], modelOutcome: "regression" });
    await orchestrateRun(h.deps, "run_1");
    expect(h.store.verdicts[0]!.verdict).toBe("broken");

    const h2 = makeHarness({
      headResults: { flw_rip: result("head", "failed") },
      baseResults: { flw_rip: result("base", "passed") },
      changedFiles: ["src/rip.ts"],
    });
    await orchestrateRun(h2.deps, "run_1");
    expect(h2.store.verdicts[0]!.verdict).toBe("broken");
  });
});

// ── Phase 8: diff-aware selection + coverage maps ──────────────────────────
describe("orchestrateRun — diff-aware selection", () => {
  const twoFlows = [
    { flowId: "flw_login", flowName: "Login", specVersionId: "fsv_login", tier: "smoke" },
    { flowId: "flw_rip", flowName: "Rip", specVersionId: "fsv_1" },
  ];
  const bothResults = (target: "head" | "base") => ({
    flw_login: { ...result(target, "passed"), flowId: "flw_login" },
    flw_rip: result(target, "passed"),
  });

  it("README-only diff: smoke runs, covered flow is ⚪ skipped with reasons in the comment", async () => {
    const h = makeHarness({
      flows: twoFlows,
      headResults: bothResults("head"),
      baseResults: bothResults("base"),
      changedFiles: ["README.md"],
    });
    h.store.coverageMapRows.push({ flowId: "flw_rip", branch: "main", sha: "old", files: ["src/rip.ts"], apiRoutes: [] });

    await orchestrateRun(h.deps, "run_1");

    expect(h.enqueued.filter((j) => j.includes("flw_rip"))).toHaveLength(0);
    expect(h.enqueued.filter((j) => j.includes("flw_login-head"))).toHaveLength(2);
    const comment = h.octo.comments[0]!.body;
    expect(comment).toContain("| Rip | ⚪ skipped | no overlap with the diff |");
    expect(comment).toContain("flows selected 1/2 (diff-aware)");
    expect(comment).toContain("Login: smoke tier");
    const plan = h.store.runPatches.find((p) => p.runId === "run_1" && p.patch.plan)!.patch
      .plan as { skipped: Array<{ flowId: string; reason: string }> };
    expect(plan.skipped[0]!.flowId).toBe("flw_rip");
  });

  it("diff touching a covered file selects the flow with the file named as reason", async () => {
    const h = makeHarness({
      flows: twoFlows,
      headResults: bothResults("head"),
      baseResults: bothResults("base"),
      changedFiles: ["src/components/PackScene.tsx"],
    });
    h.store.coverageMapRows.push({
      flowId: "flw_rip",
      branch: "main",
      sha: "old",
      files: ["src/components/PackScene.tsx", "src/app/shop/page.tsx", "src/a.ts", "src/b.ts", "src/c.ts"],
      apiRoutes: [],
    });

    await orchestrateRun(h.deps, "run_1");

    expect(h.enqueued.filter((j) => j.includes("flw_rip-head"))).toHaveLength(2);
    expect(h.octo.comments[0]!.body).toContain("Rip: touches src/components/PackScene.tsx");
  });

  it("lockfile diff fans out: everything runs even with zero coverage overlap", async () => {
    const h = makeHarness({
      flows: twoFlows,
      headResults: bothResults("head"),
      baseResults: bothResults("base"),
      changedFiles: ["pnpm-lock.yaml"],
    });
    h.store.coverageMapRows.push({ flowId: "flw_rip", branch: "main", sha: "old", files: ["src/rip.ts"], apiRoutes: [] });

    await orchestrateRun(h.deps, "run_1");

    expect(h.enqueued.filter((j) => j.includes("flw_rip-head"))).toHaveLength(2);
    expect(h.octo.comments[0]!.body).toContain("fan-out: shared config changed: pnpm-lock.yaml");
  });

  it("nothing selected: no jobs, all-⚪ comment, green status, run done", async () => {
    const h = makeHarness({
      flows: [{ flowId: "flw_rip", flowName: "Rip", specVersionId: "fsv_1" }],
      changedFiles: ["README.md"],
    });
    h.store.coverageMapRows.push({ flowId: "flw_rip", branch: "main", sha: "old", files: ["src/rip.ts"], apiRoutes: [] });

    await orchestrateRun(h.deps, "run_1");

    expect(h.enqueued).toHaveLength(0);
    expect(h.octo.comments[0]!.body).toContain("| Rip | ⚪ skipped |");
    expect(h.octo.statuses.at(-1)).toMatchObject({ state: "success" });
    expect(h.store.runs[0]!.state).toBe("done");
  });

  it("fresh base results write coverage_maps with rootDir-prefixed repo paths", async () => {
    const h = makeHarness({
      headResults: { flw_rip: result("head", "passed") },
      baseResults: {
        flw_rip: result("base", "passed", {
          coverage: { files: ["src/components/PackScene.tsx"], apiRoutes: ["/api/packs/open"], sourceMapsResolved: true },
        }),
      },
      changedFiles: ["examples/demo-app/src/anything.ts"],
    });
    h.store.projects[0]!.settings = { rootDir: "examples/demo-app" };

    await orchestrateRun(h.deps, "run_1");

    expect(h.store.coverageMapRows).toEqual([
      expect.objectContaining({
        flowId: "flw_rip",
        branch: "main",
        sha: "mergebase",
        files: ["examples/demo-app/src/components/PackScene.tsx"],
        apiRoutes: ["/api/packs/open"],
      }),
    ]);
  });

  it("coverage seeding: base cache hit is bypassed until a coverage row exists; base m1 collects", async () => {
    const h = makeHarness({
      headResults: { flw_rip: result("head", "passed") },
      baseResults: { flw_rip: result("base", "passed") },
      changedFiles: ["README.md"], // no coverage row → cold start selects the flow anyway
    });
    const cachedId = await h.store.insertRunFlowResult({
      runId: "run_0",
      flowId: "flw_rip",
      specVersionId: "fsv_1",
      target: "base",
      result: result("base", "passed"),
      fromCache: false,
    });
    await h.store.upsertBaseCache("fsv_1", "mergebase", cachedId);
    const jobs: Array<{ jobId: string; coverage: boolean }> = [];
    const orig = h.deps.enqueueFlowJob;
    h.deps.enqueueFlowJob = async (job, jobId) => {
      jobs.push({ jobId, coverage: job.collect.coverage });
      await orig(job, jobId);
    };

    await orchestrateRun(h.deps, "run_1");

    // cache was bypassed: base jobs ran despite the warm cache
    expect(jobs.filter((j) => j.jobId.includes("-base-m"))).toHaveLength(2);
    expect(jobs.find((j) => j.jobId.endsWith("-base-m1"))!.coverage).toBe(true);
    expect(jobs.find((j) => j.jobId.endsWith("-base-m2"))!.coverage).toBe(false);
    expect(jobs.find((j) => j.jobId.endsWith("-head-m1"))!.coverage).toBe(false);
  });
});
