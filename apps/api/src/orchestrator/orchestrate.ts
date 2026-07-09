import type { Logger } from "pino";
import {
  BLOCKING_VERDICTS,
  ExecuteFlowJobSchema,
  VERDICT_EMOJI,
  VERDICT_LABEL,
  type ExecuteFlowJob,
  type RunFlowResult,
  type VerdictKind,
} from "@flowguard/schemas";
import {
  renderFlowReviewComment,
  renderPreviewDetectedComment,
  setCommitStatus,
  upsertStickyComment,
  type FlowReviewRow,
} from "@flowguard/github";
import type { GithubAppClient } from "@flowguard/github";
import type { Store } from "../store.js";
import { splitRepo } from "../handlers/deps.js";
import { compareFlow, type ArtifactLinker } from "./comparator.js";
import { buildConfigBundle, MissingCredentialsError } from "./config-bundle.js";
import { MEASURE_SAMPLES, mergeMeasuredResults } from "./measure.js";

/**
 * The run state machine (doc 06 §3), Phase 3 scope:
 *   planning → resolving_base → executing → reporting → done
 * judging is stubbed (the comparator is deterministic code until Phase 9).
 */

export interface VercelDeploymentInfo {
  uid: string;
  url: string;
  state: string;
  sha: string | null;
}

export interface OrchestratorDeps {
  store: Store;
  githubApp: GithubAppClient;
  logger: Logger;
  resolveSecret: (ref: string) => Promise<string>;
  makeVercelClient: (
    token: string,
    teamId: string | null,
  ) => {
    listDeployments(opts: {
      projectId: string;
      sha?: string;
      target?: "production" | "preview";
      limit?: number;
    }): Promise<VercelDeploymentInfo[]>;
  };
  /** Enqueue a flow job; jobId is deterministic for dedupe/removal. */
  enqueueFlowJob: (job: ExecuteFlowJob, jobId: string) => Promise<void>;
  /** Fan-in: resolve the job's RunFlowResult. */
  awaitFlowResult: (jobId: string, timeoutMs: number) => Promise<RunFlowResult>;
  removeQueuedJob: (jobId: string) => Promise<void>;
  /** Signal the runner to abort between steps (doc 01 §6). */
  setAbortKey: (runId: string) => Promise<void>;
  artifactLink: ArtifactLinker;
  /** For 🟣 login_failed rows: where to enter PR-scoped credentials (doc 07 §3). */
  dashboardUrl?: string;
  flowJobTimeoutMs?: number;
}

export async function orchestrateRun(deps: OrchestratorDeps, runId: string): Promise<void> {
  const { store, logger } = deps;
  const run = await store.getRunById(runId);
  if (!run || run.kind !== "pr" || !run.prId || !run.headDeploymentId || !run.headSha) {
    logger.warn({ runId }, "orchestrate: run missing or not an executable PR run");
    return;
  }
  if (run.state !== "planning") {
    logger.info({ runId, state: run.state }, "orchestrate: run not in planning — skipped");
    return;
  }
  const project = await store.getProjectById(run.projectId);
  const pr = await store.getPullRequestById(run.prId);
  const headDeployment = await store.getDeploymentById(run.headDeploymentId);
  if (!project || !pr || !headDeployment || !project.installationId) {
    logger.error({ runId }, "orchestrate: missing project/pr/deployment context");
    await store.updateRun(runId, { state: "errored", finishedAt: new Date() });
    return;
  }
  const octokit = await deps.githubApp.getInstallationOctokit(project.installationId);
  const { owner, repo } = splitRepo(project.githubRepo);
  const sticky = async (body: string) => {
    const { commentId } = await upsertStickyComment(
      octokit.rest.issues,
      { owner, repo, prNumber: pr.number },
      body,
      pr.stickyCommentId,
    );
    if (commentId !== pr.stickyCommentId) await store.setStickyCommentId(pr.id, commentId);
  };
  const status = (state: "pending" | "success" | "failure" | "error", description: string) =>
    setCommitStatus(octokit.rest.repos, { owner, repo, sha: run.headSha!, state, description });

  try {
    await store.updateRun(runId, { startedAt: new Date() });

    // ── supersede: a newer deployment for this PR cancels older in-flight runs ──
    const stale = await store.listActiveRunsForPr(pr.id, runId);
    for (const old of stale) {
      await store.markSuperseded(old.id, runId);
      await deps.setAbortKey(old.id);
      logger.info({ superseded: old.id, by: runId }, "older run superseded");
    }

    // ── planning: all non-archived official flows (diff-aware selection = Phase 8) ──
    const flowList = await store.listOfficialFlows(project.id, pr.baseBranch);
    if (flowList.length === 0) {
      await sticky(renderPreviewDetectedComment({ previewUrl: headDeployment.url, sha: run.headSha }));
      await status("success", "preview detected — no flows configured yet");
      await store.updateRun(runId, { state: "done", finishedAt: new Date() });
      return;
    }
    await status("pending", `running ${flowList.length} flows…`);

    // ── resolving_base ──
    await store.updateRun(runId, { state: "resolving_base" });
    const { data: cmp } = await octokit.rest.repos.compareCommitsWithBasehead({
      owner,
      repo,
      basehead: `${pr.baseBranch}...${run.headSha}`,
    });
    const mergeBaseSha: string = cmp.merge_base_commit.sha;

    const baseDeployment = await resolveBaseDeployment(deps, project, mergeBaseSha, octokit, owner, repo);
    await store.updateRun(runId, {
      mergeBaseSha,
      baseDeploymentId: baseDeployment?.id ?? null,
      plan: {
        flows: flowList.map((f) => ({ flowId: f.flowId, specVersionId: f.specVersionId, reason: "all-official" })),
        baseResolved: Boolean(baseDeployment),
      },
    });

    // ── executing: fan out head (+ base on cache miss) jobs ──
    await store.updateRun(runId, { state: "executing" });
    const bypassSecret = project.vercelBypassSecretRef
      ? await deps.resolveSecret(project.vercelBypassSecretRef)
      : null;
    const timeoutMs = deps.flowJobTimeoutMs ?? 300_000;
    // by convention the flow named "Login" establishes persona sessions (doc 07 §5)
    const loginSpec = flowList.find((f) => f.flowName.toLowerCase() === "login")?.spec ?? null;

    interface FlowPlan {
      flowId: string;
      flowName: string;
      specVersionId: string;
      spec: (typeof flowList)[number]["spec"];
      headJobIds: string[];
      baseJobIds: string[];
      cachedBase: RunFlowResult | null;
      /** synthesized without execution (e.g. missing credentials) */
      syntheticHead: RunFlowResult | null;
    }

    const enqueueTarget = async (
      f: (typeof flowList)[number],
      target: "head" | "base",
      deploymentUrl: string,
      sha: string,
      deploymentId: string,
    ): Promise<{ jobIds: string[]; synthetic: RunFlowResult | null }> => {
      try {
        const configBundle = await buildConfigBundle(
          {
            store,
            projectId: project.id,
            prNumber: target === "head" ? pr.number : null,
            deploymentId,
            loginSpec: f.flowName.toLowerCase() === "login" ? null : loginSpec,
          },
          f.spec,
        );
        // median-of-N measurement (doc 04 §4): sample 1 is authoritative for
        // pass/fail; later samples contribute timing only
        const jobIds: string[] = [];
        for (let sample = 1; sample <= MEASURE_SAMPLES; sample++) {
          const jobId = `${runId}-${f.flowId}-${target}-m${sample}`;
          await deps.enqueueFlowJob(
            buildJob(runId, f, target, deploymentUrl, sha, bypassSecret, deploymentId, configBundle, "measure"),
            jobId,
          );
          jobIds.push(jobId);
        }
        return { jobIds, synthetic: null };
      } catch (err) {
        if (err instanceof MissingCredentialsError) {
          logger.warn({ flow: f.flowId, persona: err.persona, target }, "no credentials — flow not executed");
          return { jobIds: [], synthetic: syntheticLoginFailure(runId, f, target, err.message) };
        }
        throw err;
      }
    };

    // warm-up per target, timings discarded (doc 04 §4: serverless cold starts
    // are the #1 flake source) — the cheapest flow warms routes + session cache
    const warmupFlow = flowList[0]!;
    const warmup = async (target: "head" | "base", url: string, sha: string, depId: string) => {
      try {
        const bundle = await buildConfigBundle(
          { store, projectId: project.id, prNumber: target === "head" ? pr.number : null, deploymentId: depId, loginSpec: warmupFlow.flowName.toLowerCase() === "login" ? null : loginSpec },
          warmupFlow.spec,
        );
        const jobId = `${runId}-warmup-${target}`;
        await deps.enqueueFlowJob(
          buildJob(runId, warmupFlow, target, url, sha, bypassSecret, depId, bundle, "warmup"),
          jobId,
        );
        await deps.awaitFlowResult(jobId, timeoutMs);
      } catch (err) {
        logger.warn({ err: String(err).slice(0, 120), target }, "warm-up failed — proceeding to measured runs");
      }
    };
    const anyBaseCacheMiss = baseDeployment
      ? (
          await Promise.all(flowList.map((f) => store.getCachedBaseResult(f.specVersionId, mergeBaseSha)))
        ).some((c) => c === null)
      : false;
    await Promise.all([
      warmup("head", headDeployment.url, run.headSha, headDeployment.id),
      ...(baseDeployment && anyBaseCacheMiss
        ? [warmup("base", baseDeployment.url, mergeBaseSha, baseDeployment.id)]
        : []),
    ]);

    const plans: FlowPlan[] = [];
    let cacheHits = 0;
    for (const f of flowList) {
      const headRes = await enqueueTarget(f, "head", headDeployment.url, run.headSha, headDeployment.id);
      let baseJobIds: string[] = [];
      let cachedBase: RunFlowResult | null = null;
      if (baseDeployment) {
        const cached = await store.getCachedBaseResult(f.specVersionId, mergeBaseSha);
        if (cached) {
          cachedBase = cached.result;
          cacheHits++;
        } else {
          const baseRes = await enqueueTarget(f, "base", baseDeployment.url, mergeBaseSha, baseDeployment.id);
          baseJobIds = baseRes.jobIds;
        }
      }
      plans.push({
        ...f,
        headJobIds: headRes.jobIds,
        baseJobIds,
        cachedBase,
        syntheticHead: headRes.synthetic,
      });
    }

    const awaitMerged = async (jobIds: string[]): Promise<RunFlowResult> => {
      const [m1, ...rest] = await Promise.all(jobIds.map((id) => deps.awaitFlowResult(id, timeoutMs)));
      return mergeMeasuredResults(m1!, rest[0] ?? null);
    };

    const headStart = Date.now();
    const outcomes = await Promise.all(
      plans.map(async (p) => {
        const head = p.syntheticHead ?? (await awaitMerged(p.headJobIds));
        const base = p.baseJobIds.length > 0 ? await awaitMerged(p.baseJobIds) : p.cachedBase;
        return { plan: p, head, base };
      }),
    );
    const headRunSecs = Math.round((Date.now() - headStart) / 1000);

    // superseded mid-flight? a newer run owns the comment now — stop quietly
    const self = await store.getRunById(runId);
    if (!self || self.state === "cancelled") {
      logger.info({ runId }, "run superseded during execution — not reporting");
      return;
    }

    // persist results + base cache
    for (const o of outcomes) {
      await store.insertRunFlowResult({
        runId,
        flowId: o.plan.flowId,
        specVersionId: o.plan.specVersionId,
        target: "head",
        result: o.head,
        fromCache: false,
      });
      if (o.base) {
        const resultId = await store.insertRunFlowResult({
          runId,
          flowId: o.plan.flowId,
          specVersionId: o.plan.specVersionId,
          target: "base",
          result: o.base,
          fromCache: o.plan.cachedBase !== null,
        });
        if (o.plan.baseJobIds.length > 0) {
          await store.upsertBaseCache(o.plan.specVersionId, mergeBaseSha, resultId);
          // perf baseline write path (doc 05 §4; full base-run refresh in Phase 10)
          for (const step of o.base.steps) {
            const stepSpec = o.plan.spec.steps.find((st) => st.id === step.id);
            if (stepSpec?.timingBaselineKey && o.base.status === "passed") {
              await store.upsertPerfBaseline({
                flowId: o.plan.flowId,
                branch: pr.baseBranch,
                sha: mergeBaseSha,
                stepKey: stepSpec.timingBaselineKey,
                medianMs: step.durationMs,
                samples: MEASURE_SAMPLES,
              });
            }
          }
        }
      }
    }

    // ── judging (stubbed): deterministic comparator → reporting ──
    await store.updateRun(runId, { state: "reporting" });
    await store.deleteVerdictsForRun(runId); // reruns replace their verdicts
    const rows: FlowReviewRow[] = [];
    const kinds: VerdictKind[] = [];
    for (const o of outcomes) {
      const cmp2 = compareFlow({
        spec: o.plan.spec,
        head: o.head,
        base: o.base,
        baseAvailable: Boolean(baseDeployment),
        link: deps.artifactLink,
        credentialsUrl: deps.dashboardUrl
          ? `${deps.dashboardUrl}/projects/${project.id}?pr=${pr.number}`
          : undefined,
      });
      kinds.push(cmp2.verdict);
      rows.push({
        flowName: o.plan.flowName,
        emoji: VERDICT_EMOJI[cmp2.verdict],
        label: VERDICT_LABEL[cmp2.verdict],
        detail: cmp2.detail,
      });
      await store.insertVerdict({
        runId,
        flowId: o.plan.flowId,
        verdict: cmp2.verdict,
        humanCopy: cmp2.detail,
        evidence: { head: o.head.artifacts, base: o.base?.artifacts ?? null },
      });
    }

    const pushNumber = await store.countRunsForPr(pr.id);
    await sticky(
      renderFlowReviewComment({
        headSha: run.headSha,
        pushNumber,
        baseBranch: pr.baseBranch,
        mergeBaseSha: baseDeployment ? mergeBaseSha : null,
        previewHost: headDeployment.url.replace(/^https?:\/\//, ""),
        rows,
        runDetails: `base cache hit ${cacheHits}/${flowList.length} flows · head run ${headRunSecs}s · flows selected ${flowList.length}/${flowList.length} (diff-aware selection lands in Phase 8)`,
      }),
    );

    const blocking = kinds.filter((k) => BLOCKING_VERDICTS.includes(k));
    const envIssues = kinds.filter((k) => k === "env_issue").length;
    if (blocking.length > 0) {
      const names = rows.filter((r) => r.emoji === "🔴" || r.emoji === "🟠").map((r) => r.flowName);
      await status("failure", `${blocking.length} flow${blocking.length > 1 ? "s" : ""} broken: ${names.join(", ")}`);
    } else if (envIssues > 0) {
      await status("success", `flows green (${envIssues} env issue${envIssues > 1 ? "s" : ""} — see comment)`);
    } else {
      await status("success", `all ${flowList.length} flows passing`);
    }

    await store.updateRun(runId, { state: "done", finishedAt: new Date() });
    logger.info({ runId, verdicts: kinds }, "run reported");
  } catch (err) {
    logger.error({ err, runId }, "orchestration errored");
    await store.updateRun(runId, { state: "errored", finishedAt: new Date() });
    await status("error", "FlowGuard hit an internal error — see api logs").catch(() => {});
  }
}

function buildJob(
  runId: string,
  f: { flowId: string; specVersionId: string; spec: ExecuteFlowJob["spec"] },
  target: "head" | "base",
  deploymentUrl: string,
  sha: string,
  bypassSecret: string | null,
  deploymentId: string,
  configBundle: ExecuteFlowJob["configBundle"],
  mode: "measure" | "warmup" = "measure",
): ExecuteFlowJob {
  return ExecuteFlowJobSchema.parse({
    runId,
    flowId: f.flowId,
    specVersionId: f.specVersionId,
    spec: f.spec,
    target: {
      kind: target,
      deploymentUrl: deploymentUrl.startsWith("http") ? deploymentUrl : `https://${deploymentUrl}`,
      bypassSecret,
      sha,
      deploymentId,
    },
    configBundle,
    mode,
    collect: { coverage: false, har: true, video: mode !== "warmup" },
    abortToken: runId,
  });
}

/** RunFlowResult for a flow that never executed because credentials are missing. */
function syntheticLoginFailure(
  runId: string,
  f: { flowId: string; specVersionId: string },
  target: "head" | "base",
  message: string,
): RunFlowResult {
  return {
    runId,
    flowId: f.flowId,
    specVersionId: f.specVersionId,
    target,
    status: "error",
    failedStepId: null,
    failureClass: "login_failed",
    healAttempt: { attempted: false, succeeded: false, proposedPatch: null },
    steps: [],
    perf: { flowTotalMs: 0, regressions: [] },
    artifacts: { video: null, trace: null, har: null, console: null, coverage: null },
    diagnostics: {
      pendingRequestsAtTimeout: [],
      consoleErrors: [{ text: message }],
      pageCrashed: false,
      nextErrorOverlay: false,
      blankScreenScore: 0,
    },
  };
}

/**
 * Latest successful base-branch deployment at (or nearest ancestor of) the merge
 * base (doc 06 §3 resolving_base). Exact SHA match first; else newest production
 * deployment whose SHA is an ancestor of the merge base.
 */
async function resolveBaseDeployment(
  deps: OrchestratorDeps,
  project: NonNullable<Awaited<ReturnType<Store["getProjectById"]>>>,
  mergeBaseSha: string,
  octokit: Awaited<ReturnType<GithubAppClient["getInstallationOctokit"]>>,
  owner: string,
  repo: string,
): Promise<{ id: string; url: string } | null> {
  if (!project.vercelProjectId || !project.vercelTokenRef) return null;
  try {
    const token = await deps.resolveSecret(project.vercelTokenRef);
    const vercel = deps.makeVercelClient(token, project.vercelTeamId);

    let match = (
      await vercel.listDeployments({ projectId: project.vercelProjectId, sha: mergeBaseSha, limit: 5 })
    ).find((d) => d.state === "READY");

    if (!match) {
      const candidates = await vercel.listDeployments({
        projectId: project.vercelProjectId,
        target: "production",
        limit: 20,
      });
      for (const d of candidates) {
        if (d.state !== "READY" || !d.sha) continue;
        if (d.sha === mergeBaseSha) {
          match = d;
          break;
        }
        try {
          const { data } = await octokit.rest.repos.compareCommitsWithBasehead({
            owner,
            repo,
            basehead: `${d.sha}...${mergeBaseSha}`,
          });
          // identical/ahead ⇒ the deployment's sha is at or behind the merge base
          if (data.status === "identical" || data.status === "ahead") {
            match = d;
            break;
          }
        } catch {
          continue;
        }
      }
    }
    if (!match) return null;
    const row = await deps.store.upsertDeployment({
      projectId: project.id,
      vercelDeploymentId: match.uid,
      sha: match.sha ?? mergeBaseSha,
      url: match.url.startsWith("http") ? match.url : `https://${match.url}`,
      environment: "production",
      state: "ready",
    });
    return { id: row.id, url: row.url };
  } catch (err) {
    deps.logger.warn({ err }, "base deployment resolution failed — head-only run");
    return null;
  }
}
