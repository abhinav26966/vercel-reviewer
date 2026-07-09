import type { OrchestratorDeps } from "./orchestrate.js";

/**
 * Cron surface (doc 06 §6): nightly full base run per configured branch
 * (skipped if one ran in the last 12h — catches drift with zero merges),
 * hourly stuck-run sweep, daily expiry purge.
 */

export interface SchedulerDeps extends OrchestratorDeps {
  enqueueBaseRun: (runId: string) => Promise<void>;
  /** Optional artifact purge hook (S3 lifecycle rules are the primary path). */
  purgeArtifacts?: (olderThan: Date) => Promise<number>;
}

/** Resolve the branch's latest READY deployment and start a base run. */
export async function startBaseRun(
  deps: SchedulerDeps,
  projectId: string,
  branch: string,
): Promise<string | null> {
  const { store, logger } = deps;
  const project = await store.getProjectById(projectId);
  if (!project?.vercelProjectId || !project.vercelTokenRef) return null;
  const token = await deps.resolveSecret(project.vercelTokenRef);
  const vercel = deps.makeVercelClient(token, project.vercelTeamId);
  // v1: the production target IS the primary base branch; additional base
  // branches ride the deployment_status trigger (doc 06 §2) until the Vercel
  // client learns branch-filtered listing
  const candidates = await vercel.listDeployments({
    projectId: project.vercelProjectId,
    target: "production",
    limit: 10,
  });
  const target = candidates.find((d) => d.state === "READY");
  if (!target) {
    logger.warn({ projectId, branch }, "no READY deployment for base run");
    return null;
  }
  const deployment = await store.upsertDeployment({
    projectId,
    vercelDeploymentId: target.uid,
    sha: target.sha ?? "unknown",
    url: target.url.startsWith("http") ? target.url : `https://${target.url}`,
    environment: "production",
    state: "ready",
  });
  const { run, created } = await store.createRun({
    projectId,
    kind: "base",
    state: "planning",
    headSha: target.sha ?? "unknown",
    headDeploymentId: deployment.id,
    branch,
  });
  if (!created) {
    // an identical base run exists; re-enqueue only if it never finished
    const existing = await store.getRunById(run.id);
    if (existing && ["done", "errored", "cancelled"].includes(existing.state)) {
      await store.updateRun(run.id, { state: "planning" });
    }
  }
  await deps.enqueueBaseRun(run.id);
  logger.info({ run: run.id, branch, sha: target.sha }, "base run started");
  return run.id;
}

export async function nightlyBaseRuns(deps: SchedulerDeps): Promise<void> {
  const projects = await deps.store.listProjects();
  const cutoff = new Date(Date.now() - 12 * 3600_000);
  for (const project of projects) {
    for (const branch of project.baseBranches) {
      const last = await deps.store.lastBaseRunAt(project.id, branch);
      if (last && last > cutoff) {
        deps.logger.debug({ project: project.id, branch }, "nightly: base run fresh — skipped");
        continue;
      }
      await startBaseRun(deps, project.id, branch).catch((err) =>
        deps.logger.warn({ err, project: project.id, branch }, "nightly base run failed to start"),
      );
    }
  }
}

/** executing > 45min → errored + alert (doc 06 §6). */
export async function sweepStuckRuns(deps: SchedulerDeps): Promise<number> {
  const cutoff = new Date(Date.now() - 45 * 60_000);
  const stuck = await deps.store.listStuckRuns(cutoff);
  for (const run of stuck) {
    await deps.store.updateRun(run.id, { state: "errored", finishedAt: new Date() });
    await deps.setAbortKey(run.id);
    await deps.store.createAlert({
      projectId: run.projectId,
      kind: "stuck_run",
      payload: { runId: run.id, kind: run.kind, state: run.state, message: `run ${run.id} stuck in ${run.state} >45min — errored` },
    });
    deps.logger.warn({ run: run.id, state: run.state }, "stuck run swept");
  }
  return stuck.length;
}

export async function purgeExpired(deps: SchedulerDeps): Promise<void> {
  const purgedCreds = await deps.store.deleteExpiredPrCredentials(new Date());
  let purgedArtifacts = 0;
  if (deps.purgeArtifacts) {
    const retentionDays = 30; // per-project override reads settings in the loop below when needed
    purgedArtifacts = await deps.purgeArtifacts(new Date(Date.now() - retentionDays * 86_400_000));
  }
  deps.logger.info({ purgedCreds, purgedArtifacts }, "expiry purge complete");
}
