import { ProjectSettingsSchema, type RunFlowResult } from "@flowguard/schemas";
import { buildConfigBundle, MissingCredentialsError } from "./config-bundle.js";
import { MEASURE_SAMPLES, mergeMeasuredResults } from "./measure.js";
import { buildJob, type OrchestratorDeps } from "./orchestrate.js";

/**
 * Base-branch runs — the loop-closer (doc 05 §5). Always the FULL suite
 * (never diff-selected: baselines must be complete and this is the safety net
 * for mapping errors), warmup+measure with coverage collection. Per flow:
 *
 *   1. promotion reconciliation — pending green on the new base → promote,
 *      archive predecessor; official AND pending both red → alert + hold;
 *   2. baseline refresh — green official → perf medians + coverage + result
 *      cache at this SHA (all three rot together, refresh together);
 *   3. broken-on-base — red official → alert immediately + quarantine; a
 *      green run auto-unquarantines. Never let a base regression burn
 *      innocent PR authors.
 */

export async function orchestrateBaseRun(deps: OrchestratorDeps, runId: string): Promise<void> {
  const { store, logger } = deps;
  const run = await store.getRunById(runId);
  if (!run || run.kind !== "base" || !run.branch || !run.headDeploymentId || !run.headSha) {
    logger.warn({ runId }, "base run missing or not executable");
    return;
  }
  if (run.state !== "planning") {
    logger.info({ runId, state: run.state }, "base run not in planning — skipped");
    return;
  }
  const project = await store.getProjectById(run.projectId);
  const deployment = await store.getDeploymentById(run.headDeploymentId);
  if (!project || !deployment) {
    await store.updateRun(runId, { state: "errored", finishedAt: new Date() });
    return;
  }
  const settings = ProjectSettingsSchema.parse(project.settings ?? {});
  const branch = run.branch;
  const sha = run.headSha;

  try {
    await store.updateRun(runId, { startedAt: new Date(), state: "executing" });

    // per-branch serialization, newest-wins (doc 05 §5): this run supersedes
    // older in-flight base runs for the same branch
    const stale = await store.listActiveBaseRuns(project.id, branch, runId);
    for (const old of stale) {
      await store.markSuperseded(old.id, runId);
      await deps.setAbortKey(old.id);
      logger.info({ superseded: old.id, by: runId }, "older base run superseded");
    }

    const suite = await store.listBaseSuite(project.id, branch);
    if (suite.length === 0) {
      await store.updateRun(runId, { state: "done", finishedAt: new Date() });
      return;
    }
    const bypassSecret = project.vercelBypassSecretRef
      ? await deps.resolveSecret(project.vercelBypassSecretRef)
      : null;
    const timeoutMs = deps.flowJobTimeoutMs ?? 600_000;
    const loginSpec = suite.find((f) => f.flowName.toLowerCase() === "login")?.official.spec ?? null;

    const bundleFor = async (flowName: string, spec: (typeof suite)[number]["official"]["spec"]) =>
      buildConfigBundle(
        {
          store,
          projectId: project.id,
          prNumber: null,
          deploymentId: deployment.id,
          loginSpec: flowName.toLowerCase() === "login" ? null : loginSpec,
        },
        spec,
      );

    // warm-up, timings discarded (doc 04 §4)
    try {
      const w = suite[0]!;
      const jobId = `${runId}-warmup-base`;
      await deps.enqueueFlowJob(
        buildJob(runId, { flowId: w.flowId, specVersionId: w.official.versionId, spec: w.official.spec }, "base", deployment.url, sha, bypassSecret, deployment.id, await bundleFor(w.flowName, w.official.spec), "warmup"),
        jobId,
      );
      await deps.awaitFlowResult(jobId, timeoutMs);
    } catch (err) {
      logger.warn({ err: String(err).slice(0, 120) }, "base warm-up failed — proceeding");
    }

    // fan out: official (2 samples, coverage on m1) + pending (1 sample, coverage)
    const executions: Array<{
      f: (typeof suite)[number];
      officialJobs: string[];
      pendingJob: string | null;
    }> = [];
    for (const f of suite) {
      try {
        const bundle = await bundleFor(f.flowName, f.official.spec);
        const officialJobs: string[] = [];
        for (let sample = 1; sample <= MEASURE_SAMPLES; sample++) {
          const jobId = `${runId}-${f.flowId}-base-m${sample}`;
          await deps.enqueueFlowJob(
            buildJob(runId, { flowId: f.flowId, specVersionId: f.official.versionId, spec: f.official.spec }, "base", deployment.url, sha, bypassSecret, deployment.id, bundle, "measure", { coverage: sample === 1 }),
            jobId,
          );
          officialJobs.push(jobId);
        }
        let pendingJob: string | null = null;
        if (f.pending) {
          pendingJob = `${runId}-${f.flowId}-pending-m1`;
          await deps.enqueueFlowJob(
            buildJob(runId, { flowId: f.flowId, specVersionId: f.pending.versionId, spec: f.pending.spec }, "base", deployment.url, sha, bypassSecret, deployment.id, bundle, "measure", { coverage: true }),
            pendingJob,
          );
        }
        executions.push({ f, officialJobs, pendingJob });
      } catch (err) {
        if (err instanceof MissingCredentialsError) {
          logger.warn({ flow: f.flowId }, "base run: missing credentials — flow skipped");
          continue;
        }
        throw err;
      }
    }

    const outcomes = await Promise.all(
      executions.map(async (e) => {
        const [m1, ...rest] = await Promise.all(e.officialJobs.map((id) => deps.awaitFlowResult(id, timeoutMs)));
        const official = mergeMeasuredResults(m1!, rest[0] ?? null);
        const pending = e.pendingJob ? await deps.awaitFlowResult(e.pendingJob, timeoutMs) : null;
        return { f: e.f, official, pending };
      }),
    );

    // superseded mid-flight?
    const self = await store.getRunById(runId);
    if (!self || self.state === "cancelled") {
      logger.info({ runId }, "base run superseded during execution — not reconciling");
      return;
    }

    await store.updateRun(runId, { state: "reporting" });
    const summary: Record<string, string> = {};
    for (const o of outcomes) {
      summary[o.f.flowName] = await reconcileFlow(deps, settings, project.id, branch, sha, o);
    }
    await store.updateRun(runId, {
      state: "done",
      finishedAt: new Date(),
      plan: { kind: "base", branch, sha, reconciliation: summary },
    });
    logger.info({ runId, branch, sha, summary }, "base run reconciled");
  } catch (err) {
    logger.error({ err, runId }, "base run errored");
    await store.updateRun(runId, { state: "errored", finishedAt: new Date() });
  }
}

async function reconcileFlow(
  deps: OrchestratorDeps,
  settings: { alertWebhookUrl: string | null; rootDir: string },
  projectId: string,
  branch: string,
  sha: string,
  o: {
    f: {
      flowId: string;
      flowName: string;
      official: { versionId: string; status: string; spec: { steps: Array<{ id: string; timingBaselineKey?: string | null }> } };
      pending: { versionId: string } | null;
    };
    official: RunFlowResult;
    pending: RunFlowResult | null;
  },
): Promise<string> {
  const { store, logger } = deps;
  const { f, official, pending } = o;
  const runId = official.runId;

  const persist = async (versionId: string, result: RunFlowResult) => {
    const resultId = await store.insertRunFlowResult({
      runId,
      flowId: f.flowId,
      specVersionId: versionId,
      target: "base",
      result,
      fromCache: false,
    });
    await store.upsertBaseCache(versionId, sha, resultId);
  };
  const refreshBaselines = async (result: RunFlowResult, spec: typeof f.official.spec, samples: number) => {
    for (const step of result.steps) {
      const stepSpec = spec.steps.find((s) => s.id === step.id);
      if (stepSpec?.timingBaselineKey) {
        await store.upsertPerfBaseline({
          flowId: f.flowId,
          branch,
          sha,
          stepKey: stepSpec.timingBaselineKey,
          medianMs: step.durationMs,
          samples,
        });
      }
    }
    if (result.coverage) {
      await store.upsertCoverageMap({
        flowId: f.flowId,
        branch,
        sha,
        files: result.coverage.files.map((file) => (settings.rootDir ? `${settings.rootDir}/${file}` : file)),
        apiRoutes: result.coverage.apiRoutes,
      });
    }
  };
  const alert = async (kind: string, message: string) => {
    await store.createAlert({ projectId, kind, payload: { flowId: f.flowId, flowName: f.flowName, branch, sha, message } });
    if (settings.alertWebhookUrl) {
      // fire-and-forget: alert delivery must never fail the run
      fetch(settings.alertWebhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: `🛡️ FlowGuard: ${message}` }),
      }).catch(() => {});
    }
    logger.warn({ flow: f.flowId, kind }, message);
  };

  const officialGreen = official.status === "passed";
  const pendingGreen = pending?.status === "passed";
  await persist(f.official.versionId, official);
  if (pending && f.pending) await persist(f.pending.versionId, pending);

  // inconclusive results (aborted runs, env problems, unverified payment env)
  // change NOTHING: quarantining a flow over an environment hiccup is the
  // misattribution that kills trust (doc 05 §5.3 spirit)
  const ENV_CLASSES = new Set(["env", "login_failed", "payment_unverified_env"]);
  if (
    official.status === "skipped" ||
    official.status === "error" ||
    (official.failureClass !== null && ENV_CLASSES.has(official.failureClass))
  ) {
    await alert(
      "base_inconclusive",
      `base run for "${f.flowName}" on ${branch} @ ${sha.slice(0, 7)} was inconclusive (${official.failureClass ?? official.status}) — baselines unchanged`,
    );
    return "inconclusive";
  }

  // 1. promotion reconciliation (doc 05 §5.1)
  if (f.pending && pending) {
    if (pendingGreen) {
      await store.promoteVersionToOfficial(f.pending.versionId);
      await store.archiveOtherPendings(f.flowId, branch, f.pending.versionId);
      await store.acknowledgeAlerts(projectId, "base_broken", f.flowId);
      await refreshBaselines(pending, f.official.spec, 1);
      logger.info({ flow: f.flowId, promoted: f.pending.versionId }, "pending version matches new base — promoted");
      return "promoted";
    }
    if (!officialGreen) {
      // matches NEITHER old official nor pending — the merge produced something unexpected
      await store.setVersionStatus(f.official.versionId, "quarantined");
      await store.updateVersionReport(f.official.versionId, { quarantinedSha: sha });
      await alert(
        "baseline_conflict",
        `"${f.flowName}" on ${branch} @ ${sha.slice(0, 7)} matches neither the official nor the pending baseline — both held for review`,
      );
      return "conflict";
    }
    // official green, pending red: the approved change hasn't landed yet — pending waits
    await refreshBaselines(official, f.official.spec, MEASURE_SAMPLES);
    return "pending_waiting";
  }

  // 2 & 3. baseline refresh / broken-on-base (doc 05 §5.2–5.3)
  if (officialGreen) {
    await refreshBaselines(official, f.official.spec, MEASURE_SAMPLES);
    if (f.official.status === "quarantined") {
      await store.setVersionStatus(f.official.versionId, "official");
      await store.acknowledgeAlerts(projectId, "base_broken", f.flowId);
      await alert("base_recovered", `"${f.flowName}" is green again on ${branch} @ ${sha.slice(0, 7)} — unquarantined`);
      return "unquarantined";
    }
    return "refreshed";
  }
  if (f.official.status !== "quarantined") {
    await store.setVersionStatus(f.official.versionId, "quarantined");
    await store.updateVersionReport(f.official.versionId, { quarantinedSha: sha });
    await alert(
      "base_broken",
      `"${f.flowName}" is broken on ${branch} as of ${sha.slice(0, 7)} — quarantined; PRs will report ⬜ until base is green`,
    );
    return "quarantined";
  }
  return "still_broken";
}
