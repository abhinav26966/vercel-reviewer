import type { Logger } from "pino";
import { ExecuteFlowJobSchema, type FlowSpec, type RunFlowResult } from "@flowguard/schemas";
import type { Store } from "../store.js";
import { buildConfigBundle, MissingCredentialsError } from "../orchestrator/config-bundle.js";
import { applyHealPatch } from "../orchestrator/pending-version.js";

/**
 * Draft validation (doc 03 B2.8): run the confirmed draft once against the base
 * branch deployment. Green ⇒ promoted to `official` (archiving the previous
 * official for that flow+branch); red ⇒ stays draft with the failure attached.
 *
 * Validation-as-discovery (doc 09 Phase 9 task 4): a draft with steps that
 * have NO locators (plain-language authoring) runs in `explore` mode — the
 * heal agent finds each element, and the locators it used are written back
 * into a NEW draft row for human review. Explore never promotes.
 */

export function draftNeedsExploration(spec: FlowSpec): boolean {
  return spec.steps.some(
    (s) => "locators" in s.action && Array.isArray(s.action.locators) && s.action.locators.length === 0,
  );
}
export interface ValidateDeps {
  store: Store;
  logger: Logger;
  resolveSecret: (ref: string) => Promise<string>;
  makeVercelClient: (
    token: string,
    teamId: string | null,
  ) => {
    listDeployments(opts: {
      projectId: string;
      target?: "production" | "preview";
      limit?: number;
    }): Promise<Array<{ uid: string; url: string; state: string; sha: string | null }>>;
  };
  enqueueFlowJob: (job: unknown, jobId: string) => Promise<void>;
  awaitFlowResult: (jobId: string, timeoutMs: number) => Promise<RunFlowResult>;
}

export async function validateDraft(
  deps: ValidateDeps,
  versionId: string,
): Promise<{ passed: boolean; result: RunFlowResult | null; error?: string }> {
  const { store, logger } = deps;
  const version = await store.getFlowVersion(versionId);
  if (!version) throw new Error(`version not found: ${versionId}`);
  const project = await store.getProjectById(version.spec.projectId);
  if (!project?.vercelProjectId || !project.vercelTokenRef) {
    return { passed: false, result: null, error: "project has no Vercel binding for validation" };
  }

  // latest READY base-branch (production) deployment is the validation target
  const token = await deps.resolveSecret(project.vercelTokenRef);
  const vercel = deps.makeVercelClient(token, project.vercelTeamId);
  const candidates = await vercel.listDeployments({
    projectId: project.vercelProjectId,
    target: "production",
    limit: 10,
  });
  const target = candidates.find((d) => d.state === "READY");
  if (!target) return { passed: false, result: null, error: "no READY base deployment found" };

  const deployment = await store.upsertDeployment({
    projectId: project.id,
    vercelDeploymentId: target.uid,
    sha: target.sha ?? "unknown",
    url: target.url.startsWith("http") ? target.url : `https://${target.url}`,
    environment: "production",
    state: "ready",
  });

  const { run } = await store.createRun({
    projectId: project.id,
    kind: "validation" as never,
    state: "executing",
    headSha: target.sha ?? "unknown",
    headDeploymentId: deployment.id,
    branch: version.branch,
  });
  await store.updateRun(run.id, { state: "executing" });

  const bypassSecret = project.vercelBypassSecretRef
    ? await deps.resolveSecret(project.vercelBypassSecretRef)
    : null;

  // the project's Login flow establishes sessions for persona flows
  const officialFlows = await store.listOfficialFlows(project.id, version.branch);
  const loginSpec = officialFlows.find((f) => f.flowName.toLowerCase() === "login")?.spec ?? null;

  let configBundle;
  try {
    configBundle = await buildConfigBundle(
      {
        store,
        projectId: project.id,
        prNumber: null,
        deploymentId: deployment.id,
        loginSpec: version.spec.name.toLowerCase() === "login" ? null : loginSpec,
      },
      version.spec,
    );
  } catch (err) {
    if (err instanceof MissingCredentialsError) {
      await store.updateRun(run.id, { state: "errored", finishedAt: new Date() });
      return { passed: false, result: null, error: err.message };
    }
    throw err;
  }

  const explore = draftNeedsExploration(version.spec);
  const jobId = `${run.id}-${version.flowId}-head-${Date.now()}`;
  await deps.enqueueFlowJob(
    ExecuteFlowJobSchema.parse({
      runId: run.id,
      flowId: version.flowId,
      specVersionId: versionId,
      spec: version.spec,
      target: {
        kind: "head",
        deploymentUrl: deployment.url,
        bypassSecret,
        sha: deployment.sha,
        deploymentId: deployment.id,
      },
      configBundle,
      mode: explore ? "explore" : "validate",
      collect: { coverage: false, har: true, video: true },
      abortToken: run.id,
    }),
    jobId,
  );
  const result = await deps.awaitFlowResult(jobId, 600_000);

  await store.insertRunFlowResult({
    runId: run.id,
    flowId: version.flowId,
    specVersionId: versionId,
    target: "head",
    result,
    fromCache: false,
  });
  const passed = result.status === "passed";
  await store.updateRun(run.id, { state: passed ? "done" : "errored", finishedAt: new Date() });

  if (explore) {
    // discovery: write the locators the agent used back into a NEW draft row
    const patches = ([] as unknown[]).concat(result.healAttempt.proposedPatch ?? []);
    if (patches.length > 0) {
      let spec = version.spec;
      for (const patch of patches) spec = applyHealPatch(spec, patch);
      const newDraftId = await store.insertFlowVersion({
        flowId: version.flowId,
        spec,
        status: "draft",
        branch: version.branch,
        source: "plain_language",
        sourceRecordingId: version.sourceRecordingId,
        supersedesVersionId: version.id,
        compilationReport: {
          ...(version.compilationReport ?? {}),
          exploredAt: new Date().toISOString(),
          exploreResolvedSteps: patches.length,
        },
      });
      await store.setVersionStatus(version.id, "archived");
      logger.info({ versionId, newDraftId, resolved: patches.length }, "explore resolved locators into a new draft");
      return { passed: false, result, error: `explore resolved ${patches.length} step(s) — review draft ${newDraftId}` };
    }
    logger.warn({ versionId }, "explore run resolved no locators — draft unchanged");
    return { passed: false, result, error: "explore resolved no locators" };
  }

  if (passed) {
    await store.promoteVersionToOfficial(versionId);
    logger.info({ versionId, flow: version.flowId }, "draft validated green — promoted to official");
  } else {
    await store.updateVersionReport(versionId, {
      validationFailure: {
        at: new Date().toISOString(),
        failedStepId: result.failedStepId,
        failureClass: result.failureClass,
      },
    });
    logger.warn({ versionId, failedStep: result.failedStepId }, "draft validation failed — stays draft");
  }
  return { passed, result };
}
