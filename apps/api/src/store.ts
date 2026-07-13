import { and, count, desc, eq, inArray, isNull, lt, ne, sql } from "drizzle-orm";
import type { Db } from "@flowguard/db";
import {
  alerts,
  baseResultCache,
  coverageMaps,
  credentialSets,
  paymentConfigs,
  perfBaselines,
  deployments,
  flowSpecVersions,
  flows,
  githubInstallations,
  projects,
  pullRequests,
  recordings,
  runFlowResults,
  runs,
  secrets,
  sessionStates,
  usageEvents,
  verdictReports,
  verdicts,
  webhookDeliveries,
} from "@flowguard/db";
import type { FlowSpec, RunFlowResult, VerdictKind } from "@flowguard/schemas";
import { newId } from "@flowguard/shared";

/**
 * Thin persistence layer for webhook handling. Handlers depend on this interface;
 * tests use the in-memory fake (test/fake-store.ts), production uses DrizzleStore.
 */

export interface ProjectRow {
  id: string;
  name: string;
  githubRepo: string;
  installationId: number | null;
  vercelProjectId: string | null;
  vercelTeamId: string | null;
  vercelTokenRef: string | null;
  vercelBypassSecretRef: string | null;
  baseBranches: string[];
  /** projects.settings jsonb — validate with ProjectSettingsSchema at use sites. */
  settings?: Record<string, unknown>;
}

export interface DeploymentRow {
  id: string;
  projectId: string;
  sha: string;
  url: string;
  environment: string;
  state: string;
  branch: string | null;
}

export interface PullRequestRow {
  id: string;
  projectId: string;
  number: number;
  state: string;
  baseBranch: string;
  stickyCommentId: number | null;
}

export interface CredentialSetRow {
  id: string;
  projectId: string;
  scope: "project" | "pr";
  prNumber: number | null;
  persona: string;
  usernameSecretId: string;
  passwordSecretId: string;
  dataBranchDiffers: boolean;
  usernameLast4?: string | null;
}

export interface RunRow {
  id: string;
  projectId: string;
  kind: string;
  state: string;
  prId: string | null;
  headSha: string | null;
  headDeploymentId: string | null;
  branch: string | null;
}

export interface Store {
  /** Insert-first idempotency: returns false if this delivery was already processed. */
  markDeliveryProcessed(deliveryId: string, event: string, action?: string): Promise<boolean>;

  upsertInstallation(installationId: number, accountLogin: string): Promise<void>;
  removeInstallation(installationId: number): Promise<void>;

  getProjectByRepo(repoFullName: string): Promise<ProjectRow | null>;

  upsertDeployment(input: {
    projectId: string;
    vercelDeploymentId?: string | null;
    sha: string;
    url: string;
    environment: string;
    state: string;
    branch?: string | null;
  }): Promise<DeploymentRow>;

  upsertPullRequest(input: {
    projectId: string;
    number: number;
    title?: string | null;
    body?: string | null;
    author?: string | null;
    headBranch?: string | null;
    baseBranch: string;
    state: string;
  }): Promise<PullRequestRow>;

  setStickyCommentId(prId: string, commentId: number): Promise<void>;

  /** Idempotent on (project, headSha, headDeploymentId, kind). */
  createRun(input: {
    projectId: string;
    kind: "pr" | "base" | "validation" | "nightly";
    state: string;
    prId?: string | null;
    headSha?: string | null;
    headDeploymentId?: string | null;
    branch?: string | null;
  }): Promise<{ run: RunRow; created: boolean }>;

  /**
   * Attach a deployment to the run pre-created in `awaiting_deployment` by the
   * pull_request event; moves it to `planning`. null when no awaiting run exists.
   */
  upgradeAwaitingRun(input: {
    projectId: string;
    prId: string;
    headSha: string;
    headDeploymentId: string;
  }): Promise<RunRow | null>;

  cancelOpenRunsForPr(prId: string): Promise<number>;

  // ── orchestration (Phase 3) ─────────────────────────────────────────────
  getRunById(runId: string): Promise<RunRow | null>;
  updateRun(
    runId: string,
    patch: Partial<Pick<RunRow, "state" | "headDeploymentId">> & {
      mergeBaseSha?: string | null;
      baseDeploymentId?: string | null;
      plan?: Record<string, unknown>;
      supersededBy?: string | null;
      startedAt?: Date;
      finishedAt?: Date;
    },
  ): Promise<void>;
  getProjectById(projectId: string): Promise<ProjectRow | null>;
  /** Shallow-merge a patch into projects.settings jsonb (Phase 13 settings). */
  updateProjectSettings(projectId: string, patch: Record<string, unknown>): Promise<void>;
  getPullRequestById(prId: string): Promise<(PullRequestRow & { title: string | null }) | null>;
  getDeploymentById(deploymentId: string): Promise<DeploymentRow | null>;
  getLatestDeploymentForSha(projectId: string, sha: string): Promise<DeploymentRow | null>;
  /** Non-archived flows with their official spec version for a branch. */
  listOfficialFlows(
    projectId: string,
    branch: string,
  ): Promise<Array<{ flowId: string; flowName: string; tier: string; specVersionId: string; spec: FlowSpec }>>;
  /**
   * The base-run suite (doc 05 §5): every non-archived flow's current
   * official-or-quarantined version plus its pending version when one exists.
   */
  listBaseSuite(
    projectId: string,
    branch: string,
  ): Promise<
    Array<{
      flowId: string;
      flowName: string;
      tier: string;
      official: { versionId: string; status: string; spec: FlowSpec };
      pending: { versionId: string; spec: FlowSpec } | null;
    }>
  >;
  /** Quarantined flows render ⬜ on PRs without executing (doc 05 §5.3). */
  listQuarantinedFlows(
    projectId: string,
    branch: string,
  ): Promise<Array<{ flowId: string; flowName: string; quarantinedSha: string | null }>>;
  createAlert(input: { projectId: string; kind: string; payload: Record<string, unknown> }): Promise<string>;
  listAlerts(projectId: string): Promise<
    Array<{ id: string; kind: string; payload: Record<string, unknown>; createdAt: Date }>
  >;
  acknowledgeAlerts(projectId: string, kind: string, flowId?: string): Promise<void>;
  /** Active base runs for (project, branch) created before the given run. */
  listActiveBaseRuns(projectId: string, branch: string, beforeRunId: string): Promise<RunRow[]>;
  /** Most recent base-run creation time for (project, branch); nightly skip rule. */
  lastBaseRunAt(projectId: string, branch: string): Promise<Date | null>;
  /** Runs stuck in an active state since before the cutoff (doc 06 §6 sweeper). */
  listStuckRuns(cutoff: Date): Promise<RunRow[]>;
  /** Expired PR-scoped credential sets purge (doc 06 §6); returns count. */
  deleteExpiredPrCredentials(now: Date): Promise<number>;

  // ── payments (Phase 11, doc 07 §6) ──────────────────────────────────────
  createPaymentConfig(input: {
    projectId: string;
    scope: "project" | "pr";
    prNumber: number | null;
    provider: string;
    cardSecretId: string;
    expiry: string;
    cvcSecretId: string;
    extras: Record<string, unknown>;
    testCardRecognized: boolean;
  }): Promise<string>;
  listPaymentConfigs(projectId: string): Promise<
    Array<{
      id: string;
      scope: string;
      prNumber: number | null;
      provider: string;
      cardLast4: string | null;
      expiry: string | null;
      testCardRecognized: boolean;
    }>
  >;
  deletePaymentConfig(id: string): Promise<boolean>;
  /** Per-target resolution like credentials (doc 07 §3): head → PR scope then project; base → project. */
  resolvePaymentConfig(
    projectId: string,
    prNumber: number | null,
  ): Promise<{
    provider: string;
    cardSecretId: string;
    expiry: string;
    cvcSecretId: string;
    scope: string;
    extras: Record<string, unknown>;
  } | null>;
  getCachedBaseResult(
    specVersionId: string,
    baseSha: string,
  ): Promise<{ resultId: string; result: RunFlowResult; artifacts: Record<string, string | null> } | null>;
  insertRunFlowResult(input: {
    runId: string;
    flowId: string;
    specVersionId: string;
    target: "head" | "base";
    result: RunFlowResult;
    fromCache: boolean;
  }): Promise<string>;
  upsertBaseCache(specVersionId: string, baseSha: string, resultId: string): Promise<void>;
  insertVerdict(input: {
    runId: string;
    flowId: string;
    verdict: VerdictKind;
    humanCopy: string;
    evidence: Record<string, unknown>;
    confidence?: number | null;
    rationale?: string | null;
    /** 'awaiting' for 🔵 rows (doc 05 §3.6). */
    approvalState?: string | null;
  }): Promise<string>;
  /** Reruns replace a run's verdicts wholesale. */
  deleteVerdictsForRun(runId: string): Promise<void>;
  getVerdictById(verdictId: string): Promise<{
    id: string;
    runId: string;
    flowId: string;
    verdict: string;
    humanCopy: string;
    rationale: string | null;
    approvalState: string | null;
    pendingVersionId: string | null;
  } | null>;
  setVerdictApproval(
    verdictId: string,
    patch: { approvalState: string; pendingVersionId?: string | null; verdict?: VerdictKind },
  ): Promise<void>;
  /** 🔵 rows awaiting a human decision (dashboard approval panel). */
  listAwaitingVerdicts(projectId: string): Promise<
    Array<{ id: string; runId: string; flowId: string; flowName: string; humanCopy: string; rationale: string | null }>
  >;
  /** Current official (or quarantined) version for (flow, branch). */
  getOfficialVersion(flowId: string, branch: string): Promise<{ id: string; spec: FlowSpec } | null>;
  getRunFlowResult(
    runId: string,
    flowId: string,
    target: "head" | "base",
  ): Promise<{ id: string; result: RunFlowResult } | null>;
  /** Recent successful heals with spec patches (dashboard "spec drift" panel). */
  listHealPatches(projectId: string): Promise<
    Array<{ resultId: string; runId: string; flowId: string; flowName: string; patch: unknown }>
  >;
  /** Perf baseline write path (doc 05 §4); refreshed by base runs in Phase 10. */
  upsertPerfBaseline(input: {
    flowId: string;
    branch: string;
    sha: string;
    stepKey: string;
    medianMs: number;
    samples: number;
  }): Promise<void>;
  /** Latest coverage row per (flow, branch) — the selection input (doc 08). */
  getLatestCoverageMap(
    flowId: string,
    branch: string,
  ): Promise<{ sha: string; files: string[]; apiRoutes: string[] } | null>;
  upsertCoverageMap(input: {
    flowId: string;
    branch: string;
    sha: string;
    files: string[];
    apiRoutes: string[];
  }): Promise<void>;
  /** Smoke-tier toggle (doc 06 §4.2). */
  setFlowTier(flowId: string, tier: "smoke" | "standard"): Promise<void>;
  /** After promoting one pending, retire its stale siblings (superseded approvals). */
  archiveOtherPendings(flowId: string, branch: string, exceptVersionId: string): Promise<void>;
  /** Re-recordings attach to the existing flow by (project, name). */
  getFlowByName(projectId: string, name: string): Promise<{ id: string } | null>;
  /** Dashboard flow list (all flows incl. archived, with tier). */
  listFlows(
    projectId: string,
  ): Promise<Array<{ id: string; name: string; tier: string; archived: boolean }>>;

  // ── Phase 13: reports, usage, metrics, concurrency, onboarding ───────────
  /** "This verdict was wrong" — the false-positive signal (doc 09 Phase 13). */
  createVerdictReport(input: {
    verdictId: string;
    reason: string | null;
    reportedBy: string | null;
  }): Promise<{ id: string } | null>;
  listVerdictReports(
    projectId: string,
  ): Promise<Array<{ id: string; verdictId: string; flowId: string | null; reportedVerdict: string; reason: string | null; createdAt: Date }>>;
  /** Append a usage event (run | runner_ms | inference_tokens). */
  recordUsage(input: { projectId: string; runId?: string | null; kind: string; amount: number; model?: string | null }): Promise<void>;
  /** Aggregate usage for a project since a cutoff. */
  aggregateUsage(projectId: string, since: Date): Promise<{ runs: number; runnerMs: number; inferenceTokens: number }>;
  /** Active (non-terminal) runs for a project — per-project concurrency (Phase 13). */
  countActiveRunsForProject(projectId: string): Promise<number>;
  /** Platform metrics (doc 09 Phase 13): verdict distribution, heal rate, FP rate, durations. */
  platformMetrics(since: Date): Promise<{
    verdictDistribution: Record<string, number>;
    healAttempts: number;
    healSucceeded: number;
    verdictReports: number;
    totalVerdicts: number;
    runDurations: number[];
  }>;
  /** Onboarding checklist state for a project (doc 06 §1). */
  onboardingStatus(projectId: string): Promise<{
    githubInstalled: boolean;
    vercelBound: boolean;
    credentialsSet: boolean;
    firstFlowRecorded: boolean;
    firstRunCompleted: boolean;
  }>;

  // ── recordings (Phase 5) ────────────────────────────────────────────────
  createRecording(input: {
    projectId: string;
    flowName: string | null;
    traceKey: string;
    origin: string;
    status: string;
  }): Promise<string>;
  setRecordingTraceKey(recordingId: string, traceKey: string): Promise<void>;
  getRecording(recordingId: string): Promise<{
    id: string;
    projectId: string;
    flowId: string | null;
    flowName: string | null;
    traceKey: string;
    origin: string | null;
    status: string;
  } | null>;
  updateRecording(
    recordingId: string,
    patch: { status?: string; flowId?: string | null },
  ): Promise<void>;
  listRecordings(projectId: string): Promise<
    Array<{ id: string; flowId: string | null; flowName: string | null; status: string; traceKey: string }>
  >;

  // ── flows & versions (Phase 6) ──────────────────────────────────────────
  createFlow(input: {
    id: string;
    projectId: string;
    name: string;
    tier: string;
    persona: string | null;
  }): Promise<void>;
  archiveFlow(flowId: string): Promise<void>;
  insertFlowVersion(input: {
    flowId: string;
    spec: FlowSpec;
    status: string;
    branch: string;
    source: string;
    sourceRecordingId?: string | null;
    supersedesVersionId?: string | null;
    compilationReport?: Record<string, unknown> | null;
    /** For 'pending' versions minted from an approved 🔵 (doc 05 §3.6). */
    approvedFromRunId?: string | null;
  }): Promise<string>;
  getFlowVersion(versionId: string): Promise<{
    id: string;
    flowId: string;
    spec: FlowSpec;
    status: string;
    branch: string;
    sourceRecordingId: string | null;
    compilationReport: Record<string, unknown> | null;
  } | null>;
  listDraftVersions(projectId: string): Promise<
    Array<{ id: string; flowId: string; flowName: string; branch: string; sourceRecordingId: string | null }>
  >;
  setVersionStatus(versionId: string, status: string): Promise<void>;
  /** Promote a version to official; archives the previous official for (flow, branch). */
  promoteVersionToOfficial(versionId: string): Promise<void>;
  updateVersionReport(versionId: string, patch: Record<string, unknown>): Promise<void>;
  /**
   * In-flight runs for the same PR created BEFORE the given run (a newer
   * deployment supersedes older runs — never the reverse, even when webhook
   * events arrive out of order).
   */
  listActiveRunsForPr(prId: string, beforeRunId: string): Promise<RunRow[]>;
  markSuperseded(runId: string, byRunId: string): Promise<void>;
  countRunsForPr(prId: string): Promise<number>;

  // ── credentials & sessions (Phase 4) ────────────────────────────────────
  createSecret(input: {
    projectId: string;
    kind: string;
    ciphertext: Buffer;
    dekWrapped: Buffer;
    kmsKeyId: string;
    last4: string | null;
  }): Promise<string>;
  createCredentialSet(input: {
    projectId: string;
    scope: "project" | "pr";
    prNumber: number | null;
    persona: string;
    usernameSecretId: string;
    passwordSecretId: string;
    dataBranchDiffers: boolean;
  }): Promise<CredentialSetRow>;
  listCredentialSets(projectId: string): Promise<CredentialSetRow[]>;
  deleteCredentialSet(id: string): Promise<boolean>;
  /**
   * Per-TARGET resolution (doc 07 §3): head → PR scope then project defaults;
   * base → project defaults always (pass prNumber=null). Expired sets excluded.
   */
  resolveCredentialSet(
    projectId: string,
    persona: string,
    prNumber: number | null,
  ): Promise<CredentialSetRow | null>;
  /** On PR close/merge: PR-scoped credentials expire (doc 07 §3). */
  expirePrScopedCredentials(projectId: string, prNumber: number): Promise<number>;
  getSessionStateKey(persona: string, deploymentId: string): Promise<string | null>;

  // ── dashboard v0 reads ──────────────────────────────────────────────────
  listProjects(): Promise<ProjectRow[]>;
  listRunsForProject(
    projectId: string,
    limit: number,
  ): Promise<Array<RunRow & { prNumber: number | null }>>;
  getRunDetail(runId: string): Promise<{
    run: RunRow;
    results: Array<{
      id: string;
      flowId: string;
      target: string;
      status: string;
      failureClass: string | null;
      failedStepId: string | null;
      fromCache: boolean;
      artifacts: Record<string, string | null>;
    }>;
    verdicts: Array<{ flowId: string; verdict: string; humanCopy: string }>;
  } | null>;
}

const OPEN_RUN_STATES = [
  "awaiting_deployment",
  "planning",
  "resolving_base",
  "executing",
  "judging",
  "reporting",
];

export class DrizzleStore implements Store {
  constructor(private readonly db: Db) {}

  async markDeliveryProcessed(deliveryId: string, event: string, action?: string) {
    const inserted = await this.db
      .insert(webhookDeliveries)
      .values({ id: deliveryId, event, action: action ?? null })
      .onConflictDoNothing()
      .returning({ id: webhookDeliveries.id });
    return inserted.length > 0;
  }

  async upsertInstallation(installationId: number, accountLogin: string) {
    await this.db
      .insert(githubInstallations)
      .values({ id: newId("githubInstallation"), installationId, accountLogin })
      .onConflictDoUpdate({
        target: githubInstallations.installationId,
        set: { accountLogin },
      });
  }

  async removeInstallation(installationId: number) {
    await this.db
      .delete(githubInstallations)
      .where(eq(githubInstallations.installationId, installationId));
  }

  async getProjectByRepo(repoFullName: string): Promise<ProjectRow | null> {
    const rows = await this.db
      .select({
        id: projects.id,
        name: projects.name,
        githubRepo: projects.githubRepo,
        installationId: githubInstallations.installationId,
        vercelProjectId: projects.vercelProjectId,
        vercelTeamId: projects.vercelTeamId,
        vercelTokenRef: projects.vercelTokenRef,
        vercelBypassSecretRef: projects.vercelBypassSecretRef,
        baseBranches: projects.baseBranches,
      })
      .from(projects)
      .leftJoin(
        githubInstallations,
        eq(projects.githubInstallationId, githubInstallations.id),
      )
      .where(eq(projects.githubRepo, repoFullName))
      .limit(1);
    return rows[0] ?? null;
  }

  async upsertDeployment(input: {
    projectId: string;
    vercelDeploymentId?: string | null;
    sha: string;
    url: string;
    environment: string;
    state: string;
    branch?: string | null;
  }): Promise<DeploymentRow> {
    // one row per (project, url): the URL is the stable identity Phase 1 sees
    const existing = await this.db
      .select()
      .from(deployments)
      .where(and(eq(deployments.projectId, input.projectId), eq(deployments.url, input.url)))
      .limit(1);
    if (existing[0]) {
      await this.db
        .update(deployments)
        .set({ state: input.state, branch: input.branch ?? existing[0].branch })
        .where(eq(deployments.id, existing[0].id));
      return { ...existing[0], state: input.state } as DeploymentRow;
    }
    const row = {
      id: newId("deployment"),
      projectId: input.projectId,
      vercelDeploymentId: input.vercelDeploymentId ?? null,
      sha: input.sha,
      url: input.url,
      environment: input.environment,
      state: input.state,
      branch: input.branch ?? null,
    };
    await this.db.insert(deployments).values(row);
    return row;
  }

  async upsertPullRequest(input: {
    projectId: string;
    number: number;
    title?: string | null;
    body?: string | null;
    author?: string | null;
    headBranch?: string | null;
    baseBranch: string;
    state: string;
  }): Promise<PullRequestRow> {
    const existing = await this.db
      .select()
      .from(pullRequests)
      .where(
        and(eq(pullRequests.projectId, input.projectId), eq(pullRequests.number, input.number)),
      )
      .limit(1);
    if (existing[0]) {
      await this.db
        .update(pullRequests)
        .set({
          title: input.title ?? existing[0].title,
          body: input.body ?? existing[0].body,
          headBranch: input.headBranch ?? existing[0].headBranch,
          baseBranch: input.baseBranch,
          state: input.state,
        })
        .where(eq(pullRequests.id, existing[0].id));
      return {
        id: existing[0].id,
        projectId: input.projectId,
        number: input.number,
        state: input.state,
        baseBranch: input.baseBranch,
        stickyCommentId: existing[0].stickyCommentId,
      };
    }
    const id = newId("pullRequest");
    await this.db.insert(pullRequests).values({
      id,
      projectId: input.projectId,
      number: input.number,
      title: input.title ?? null,
      body: input.body ?? null,
      author: input.author ?? null,
      headBranch: input.headBranch ?? null,
      baseBranch: input.baseBranch,
      state: input.state,
    });
    return {
      id,
      projectId: input.projectId,
      number: input.number,
      state: input.state,
      baseBranch: input.baseBranch,
      stickyCommentId: null,
    };
  }

  async setStickyCommentId(prId: string, commentId: number) {
    await this.db
      .update(pullRequests)
      .set({ stickyCommentId: commentId })
      .where(eq(pullRequests.id, prId));
  }

  async createRun(input: {
    projectId: string;
    kind: "pr" | "base";
    state: string;
    prId?: string | null;
    headSha?: string | null;
    headDeploymentId?: string | null;
    branch?: string | null;
  }): Promise<{ run: RunRow; created: boolean }> {
    // manual idempotency check: the unique index treats NULLs as distinct
    const conditions = [
      eq(runs.projectId, input.projectId),
      eq(runs.kind, input.kind),
      input.headSha ? eq(runs.headSha, input.headSha) : isNull(runs.headSha),
      input.headDeploymentId
        ? eq(runs.headDeploymentId, input.headDeploymentId)
        : isNull(runs.headDeploymentId),
    ];
    const existing = await this.db
      .select()
      .from(runs)
      .where(and(...conditions))
      .limit(1);
    if (existing[0]) {
      return { run: existing[0] as RunRow, created: false };
    }
    const row = {
      id: newId("run"),
      projectId: input.projectId,
      kind: input.kind,
      state: input.state,
      prId: input.prId ?? null,
      headSha: input.headSha ?? null,
      headDeploymentId: input.headDeploymentId ?? null,
      branch: input.branch ?? null,
    };
    await this.db.insert(runs).values(row);
    return { run: row, created: true };
  }

  async upgradeAwaitingRun(input: {
    projectId: string;
    prId: string;
    headSha: string;
    headDeploymentId: string;
  }): Promise<RunRow | null> {
    const updated = await this.db
      .update(runs)
      .set({ headDeploymentId: input.headDeploymentId, state: "planning" })
      .where(
        and(
          eq(runs.projectId, input.projectId),
          eq(runs.prId, input.prId),
          eq(runs.kind, "pr"),
          eq(runs.state, "awaiting_deployment"),
          eq(runs.headSha, input.headSha),
          isNull(runs.headDeploymentId),
        ),
      )
      .returning();
    return (updated[0] as RunRow | undefined) ?? null;
  }

  async cancelOpenRunsForPr(prId: string): Promise<number> {
    const updated = await this.db
      .update(runs)
      .set({ state: "cancelled" })
      .where(and(eq(runs.prId, prId), inArray(runs.state, OPEN_RUN_STATES)))
      .returning({ id: runs.id });
    return updated.length;
  }

  // ── orchestration (Phase 3) ─────────────────────────────────────────────

  async getRunById(runId: string): Promise<RunRow | null> {
    const rows = await this.db.select().from(runs).where(eq(runs.id, runId)).limit(1);
    return (rows[0] as RunRow | undefined) ?? null;
  }

  async updateRun(
    runId: string,
    patch: Parameters<Store["updateRun"]>[1],
  ): Promise<void> {
    await this.db.update(runs).set(patch).where(eq(runs.id, runId));
  }

  async getProjectById(projectId: string): Promise<ProjectRow | null> {
    const rows = await this.db
      .select({
        id: projects.id,
        name: projects.name,
        githubRepo: projects.githubRepo,
        installationId: githubInstallations.installationId,
        vercelProjectId: projects.vercelProjectId,
        vercelTeamId: projects.vercelTeamId,
        vercelTokenRef: projects.vercelTokenRef,
        vercelBypassSecretRef: projects.vercelBypassSecretRef,
        baseBranches: projects.baseBranches,
        settings: projects.settings,
      })
      .from(projects)
      .leftJoin(githubInstallations, eq(projects.githubInstallationId, githubInstallations.id))
      .where(eq(projects.id, projectId))
      .limit(1);
    return rows[0] ?? null;
  }

  async updateProjectSettings(projectId: string, patch: Record<string, unknown>): Promise<void> {
    const rows = await this.db.select({ settings: projects.settings }).from(projects).where(eq(projects.id, projectId)).limit(1);
    const merged = { ...((rows[0]?.settings as Record<string, unknown>) ?? {}), ...patch };
    await this.db.update(projects).set({ settings: merged }).where(eq(projects.id, projectId));
  }

  async getPullRequestById(prId: string) {
    const rows = await this.db.select().from(pullRequests).where(eq(pullRequests.id, prId)).limit(1);
    const r = rows[0];
    if (!r) return null;
    return {
      id: r.id,
      projectId: r.projectId!,
      number: r.number,
      state: r.state,
      baseBranch: r.baseBranch,
      stickyCommentId: r.stickyCommentId,
      title: r.title,
    };
  }

  async getDeploymentById(deploymentId: string): Promise<DeploymentRow | null> {
    const rows = await this.db.select().from(deployments).where(eq(deployments.id, deploymentId)).limit(1);
    return (rows[0] as DeploymentRow | undefined) ?? null;
  }

  async getLatestDeploymentForSha(projectId: string, sha: string): Promise<DeploymentRow | null> {
    const rows = await this.db
      .select()
      .from(deployments)
      .where(and(eq(deployments.projectId, projectId), eq(deployments.sha, sha)))
      .orderBy(desc(deployments.createdAt))
      .limit(1);
    return (rows[0] as DeploymentRow | undefined) ?? null;
  }

  async listOfficialFlows(projectId: string, branch: string) {
    const rows = await this.db
      .select({
        flowId: flows.id,
        flowName: flows.name,
        tier: flows.tier,
        specVersionId: flowSpecVersions.id,
        spec: flowSpecVersions.spec,
      })
      .from(flows)
      .innerJoin(flowSpecVersions, eq(flowSpecVersions.flowId, flows.id))
      .where(
        and(
          eq(flows.projectId, projectId),
          eq(flows.archived, false),
          eq(flowSpecVersions.branch, branch),
          eq(flowSpecVersions.status, "official"),
        ),
      );
    return rows;
  }

  async getCachedBaseResult(specVersionId: string, baseSha: string) {
    const rows = await this.db
      .select({
        resultId: baseResultCache.resultId,
        result: runFlowResults.result,
        artifacts: runFlowResults.artifacts,
      })
      .from(baseResultCache)
      .innerJoin(runFlowResults, eq(baseResultCache.resultId, runFlowResults.id))
      .where(and(eq(baseResultCache.specVersionId, specVersionId), eq(baseResultCache.baseSha, baseSha)))
      .limit(1);
    const r = rows[0];
    return r ? { resultId: r.resultId!, result: r.result, artifacts: r.artifacts } : null;
  }

  async insertRunFlowResult(input: {
    runId: string;
    flowId: string;
    specVersionId: string;
    target: "head" | "base";
    result: RunFlowResult;
    fromCache: boolean;
  }): Promise<string> {
    // reruns overwrite their own run's rows (UNIQUE(run, flow, target)); results
    // from distinct runs stay immutable per doc 08
    const existing = await this.db
      .select({ id: runFlowResults.id })
      .from(runFlowResults)
      .where(
        and(
          eq(runFlowResults.runId, input.runId),
          eq(runFlowResults.flowId, input.flowId),
          eq(runFlowResults.target, input.target),
        ),
      )
      .limit(1);
    const patch = {
      specVersionId: input.specVersionId,
      status: input.result.status,
      failureClass: input.result.failureClass,
      failedStepId: input.result.failedStepId,
      result: input.result,
      artifacts: input.result.artifacts as Record<string, string | null>,
      fromCache: input.fromCache,
    };
    if (existing[0]) {
      await this.db.update(runFlowResults).set(patch).where(eq(runFlowResults.id, existing[0].id));
      return existing[0].id;
    }
    const id = newId("runFlowResult");
    await this.db
      .insert(runFlowResults)
      .values({ id, runId: input.runId, flowId: input.flowId, target: input.target, ...patch });
    return id;
  }

  async deleteVerdictsForRun(runId: string): Promise<void> {
    await this.db.delete(verdicts).where(eq(verdicts.runId, runId));
  }

  async upsertPerfBaseline(input: {
    flowId: string;
    branch: string;
    sha: string;
    stepKey: string;
    medianMs: number;
    samples: number;
  }): Promise<void> {
    const existing = await this.db
      .select({ id: perfBaselines.id })
      .from(perfBaselines)
      .where(
        and(
          eq(perfBaselines.flowId, input.flowId),
          eq(perfBaselines.branch, input.branch),
          eq(perfBaselines.sha, input.sha),
          eq(perfBaselines.stepKey, input.stepKey),
        ),
      )
      .limit(1);
    if (existing[0]) {
      await this.db
        .update(perfBaselines)
        .set({ medianMs: input.medianMs, samples: input.samples })
        .where(eq(perfBaselines.id, existing[0].id));
    } else {
      await this.db.insert(perfBaselines).values({ id: newId("perfBaseline"), ...input });
    }
  }

  async getLatestCoverageMap(flowId: string, branch: string) {
    const rows = await this.db
      .select({ sha: coverageMaps.sha, files: coverageMaps.files, apiRoutes: coverageMaps.apiRoutes })
      .from(coverageMaps)
      .where(and(eq(coverageMaps.flowId, flowId), eq(coverageMaps.branch, branch)))
      .orderBy(desc(coverageMaps.updatedAt))
      .limit(1);
    return rows[0] ?? null;
  }

  async upsertCoverageMap(input: {
    flowId: string;
    branch: string;
    sha: string;
    files: string[];
    apiRoutes: string[];
  }): Promise<void> {
    const existing = await this.db
      .select({ id: coverageMaps.id })
      .from(coverageMaps)
      .where(
        and(
          eq(coverageMaps.flowId, input.flowId),
          eq(coverageMaps.branch, input.branch),
          eq(coverageMaps.sha, input.sha),
        ),
      )
      .limit(1);
    if (existing[0]) {
      await this.db
        .update(coverageMaps)
        .set({ files: input.files, apiRoutes: input.apiRoutes, updatedAt: new Date() })
        .where(eq(coverageMaps.id, existing[0].id));
    } else {
      await this.db.insert(coverageMaps).values({ id: newId("coverageMap"), ...input });
    }
  }

  async setFlowTier(flowId: string, tier: "smoke" | "standard"): Promise<void> {
    await this.db.update(flows).set({ tier }).where(eq(flows.id, flowId));
  }

  async archiveOtherPendings(flowId: string, branch: string, exceptVersionId: string): Promise<void> {
    await this.db
      .update(flowSpecVersions)
      .set({ status: "archived" })
      .where(
        and(
          eq(flowSpecVersions.flowId, flowId),
          eq(flowSpecVersions.branch, branch),
          eq(flowSpecVersions.status, "pending"),
          ne(flowSpecVersions.id, exceptVersionId),
        ),
      );
  }

  async getFlowByName(projectId: string, name: string) {
    const rows = await this.db
      .select({ id: flows.id })
      .from(flows)
      .where(and(eq(flows.projectId, projectId), eq(flows.name, name)))
      .limit(1);
    return rows[0] ?? null;
  }

  async listFlows(projectId: string) {
    return this.db
      .select({ id: flows.id, name: flows.name, tier: flows.tier, archived: flows.archived })
      .from(flows)
      .where(eq(flows.projectId, projectId))
      .orderBy(flows.name);
  }

  // ── Phase 13 ─────────────────────────────────────────────────────────────
  async createVerdictReport(input: { verdictId: string; reason: string | null; reportedBy: string | null }) {
    const rows = await this.db
      .select({ id: verdicts.id, runId: verdicts.runId, flowId: verdicts.flowId, verdict: verdicts.verdict })
      .from(verdicts)
      .where(eq(verdicts.id, input.verdictId))
      .limit(1);
    const v = rows[0];
    if (!v) return null;
    // resolve projectId via the run
    const run = v.runId ? await this.getRunById(v.runId) : null;
    const id = newId("verdictReport");
    await this.db.insert(verdictReports).values({
      id,
      verdictId: v.id,
      projectId: run?.projectId ?? null,
      runId: v.runId,
      flowId: v.flowId,
      reportedVerdict: v.verdict,
      reason: input.reason,
      reportedBy: input.reportedBy,
    });
    return { id };
  }

  async listVerdictReports(projectId: string) {
    const rows = await this.db
      .select({
        id: verdictReports.id,
        verdictId: verdictReports.verdictId,
        flowId: verdictReports.flowId,
        reportedVerdict: verdictReports.reportedVerdict,
        reason: verdictReports.reason,
        createdAt: verdictReports.createdAt,
      })
      .from(verdictReports)
      .where(eq(verdictReports.projectId, projectId))
      .orderBy(desc(verdictReports.createdAt));
    return rows.map((r) => ({ ...r, verdictId: r.verdictId! }));
  }

  async recordUsage(input: { projectId: string; runId?: string | null; kind: string; amount: number; model?: string | null }) {
    await this.db.insert(usageEvents).values({
      id: newId("usageEvent"),
      projectId: input.projectId,
      runId: input.runId ?? null,
      kind: input.kind,
      amount: Math.round(input.amount),
      model: input.model ?? null,
    });
  }

  async aggregateUsage(projectId: string, since: Date) {
    const rows = await this.db
      .select({ kind: usageEvents.kind, total: sql<number>`sum(${usageEvents.amount})::int` })
      .from(usageEvents)
      .where(and(eq(usageEvents.projectId, projectId), sql`${usageEvents.createdAt} >= ${since}`))
      .groupBy(usageEvents.kind);
    const by = new Map(rows.map((r) => [r.kind, Number(r.total)]));
    return {
      runs: by.get("run") ?? 0,
      runnerMs: by.get("runner_ms") ?? 0,
      inferenceTokens: by.get("inference_tokens") ?? 0,
    };
  }

  async countActiveRunsForProject(projectId: string): Promise<number> {
    const active = ["awaiting_deployment", "planning", "resolving_base", "executing", "judging", "reporting"];
    const rows = await this.db
      .select({ n: count() })
      .from(runs)
      .where(and(eq(runs.projectId, projectId), inArray(runs.state, active)));
    return Number(rows[0]?.n ?? 0);
  }

  async platformMetrics(since: Date) {
    const vRows = await this.db
      .select({ verdict: verdicts.verdict, n: count() })
      .from(verdicts)
      .where(sql`${verdicts.createdAt} >= ${since}`)
      .groupBy(verdicts.verdict);
    const verdictDistribution: Record<string, number> = {};
    let totalVerdicts = 0;
    for (const r of vRows) {
      verdictDistribution[r.verdict] = Number(r.n);
      totalVerdicts += Number(r.n);
    }
    const healRows = await this.db
      .select({ result: runFlowResults.result })
      .from(runFlowResults)
      .where(and(eq(runFlowResults.target, "head"), sql`${runFlowResults.createdAt} >= ${since}`));
    let healAttempts = 0;
    let healSucceeded = 0;
    for (const r of healRows) {
      if (r.result.healAttempt?.attempted) healAttempts++;
      if (r.result.healAttempt?.succeeded) healSucceeded++;
    }
    const reportRows = await this.db
      .select({ n: count() })
      .from(verdictReports)
      .where(sql`${verdictReports.createdAt} >= ${since}`);
    const runRows = await this.db
      .select({ startedAt: runs.startedAt, finishedAt: runs.finishedAt })
      .from(runs)
      .where(and(eq(runs.state, "done"), sql`${runs.finishedAt} >= ${since}`));
    const runDurations = runRows
      .filter((r) => r.startedAt && r.finishedAt)
      .map((r) => r.finishedAt!.getTime() - r.startedAt!.getTime());
    return {
      verdictDistribution,
      healAttempts,
      healSucceeded,
      verdictReports: Number(reportRows[0]?.n ?? 0),
      totalVerdicts,
      runDurations,
    };
  }

  async onboardingStatus(projectId: string) {
    const project = await this.getProjectById(projectId);
    const credRows = await this.db.select({ n: count() }).from(credentialSets).where(eq(credentialSets.projectId, projectId));
    const flowRows = await this.db.select({ n: count() }).from(flows).where(eq(flows.projectId, projectId));
    const runRows = await this.db.select({ n: count() }).from(runs).where(and(eq(runs.projectId, projectId), eq(runs.state, "done")));
    return {
      githubInstalled: Boolean(project?.installationId),
      vercelBound: Boolean(project?.vercelProjectId && project?.vercelTokenRef),
      credentialsSet: Number(credRows[0]?.n ?? 0) > 0,
      firstFlowRecorded: Number(flowRows[0]?.n ?? 0) > 0,
      firstRunCompleted: Number(runRows[0]?.n ?? 0) > 0,
    };
  }

  async listBaseSuite(projectId: string, branch: string) {
    const rows = await this.db
      .select({
        flowId: flows.id,
        flowName: flows.name,
        tier: flows.tier,
        versionId: flowSpecVersions.id,
        status: flowSpecVersions.status,
        spec: flowSpecVersions.spec,
      })
      .from(flows)
      .innerJoin(flowSpecVersions, eq(flowSpecVersions.flowId, flows.id))
      .where(
        and(
          eq(flows.projectId, projectId),
          eq(flows.archived, false),
          eq(flowSpecVersions.branch, branch),
          inArray(flowSpecVersions.status, ["official", "quarantined", "pending"]),
        ),
      )
      // multiple pendings can exist (several approvals); the NEWEST wins below
      .orderBy(desc(flowSpecVersions.createdAt));
    const byFlow = new Map<string, (typeof rows)[number][]>();
    for (const r of rows) {
      byFlow.set(r.flowId, [...(byFlow.get(r.flowId) ?? []), r]);
    }
    const suite = [];
    for (const versions of byFlow.values()) {
      const official = versions.find((v) => v.status === "official" || v.status === "quarantined");
      if (!official) continue;
      const pending = versions.find((v) => v.status === "pending") ?? null;
      suite.push({
        flowId: official.flowId,
        flowName: official.flowName,
        tier: official.tier,
        official: { versionId: official.versionId, status: official.status, spec: official.spec },
        pending: pending ? { versionId: pending.versionId, spec: pending.spec } : null,
      });
    }
    return suite;
  }

  async listQuarantinedFlows(projectId: string, branch: string) {
    const rows = await this.db
      .select({
        flowId: flows.id,
        flowName: flows.name,
        report: flowSpecVersions.compilationReport,
      })
      .from(flows)
      .innerJoin(flowSpecVersions, eq(flowSpecVersions.flowId, flows.id))
      .where(
        and(
          eq(flows.projectId, projectId),
          eq(flows.archived, false),
          eq(flowSpecVersions.branch, branch),
          eq(flowSpecVersions.status, "quarantined"),
        ),
      );
    return rows.map((r) => ({
      flowId: r.flowId,
      flowName: r.flowName,
      quarantinedSha: ((r.report as Record<string, unknown> | null)?.quarantinedSha as string) ?? null,
    }));
  }

  async createAlert(input: { projectId: string; kind: string; payload: Record<string, unknown> }) {
    const id = newId("alert");
    await this.db.insert(alerts).values({ id, ...input });
    return id;
  }

  async listAlerts(projectId: string) {
    const rows = await this.db
      .select({ id: alerts.id, kind: alerts.kind, payload: alerts.payload, createdAt: alerts.createdAt })
      .from(alerts)
      .where(and(eq(alerts.projectId, projectId), isNull(alerts.acknowledgedAt)))
      .orderBy(desc(alerts.createdAt));
    return rows;
  }

  async acknowledgeAlerts(projectId: string, kind: string, flowId?: string) {
    const open = await this.db
      .select({ id: alerts.id, payload: alerts.payload })
      .from(alerts)
      .where(and(eq(alerts.projectId, projectId), eq(alerts.kind, kind), isNull(alerts.acknowledgedAt)));
    const ids = open
      .filter((a) => !flowId || (a.payload as Record<string, unknown>).flowId === flowId)
      .map((a) => a.id);
    if (ids.length > 0) {
      await this.db.update(alerts).set({ acknowledgedAt: new Date() }).where(inArray(alerts.id, ids));
    }
  }

  async listActiveBaseRuns(projectId: string, branch: string, beforeRunId: string): Promise<RunRow[]> {
    const active = ["planning", "resolving_base", "executing", "judging", "reporting"];
    const selfRows = await this.db
      .select({ createdAt: runs.createdAt })
      .from(runs)
      .where(eq(runs.id, beforeRunId))
      .limit(1);
    const selfCreatedAt = selfRows[0]?.createdAt;
    const rows = await this.db
      .select()
      .from(runs)
      .where(
        and(
          eq(runs.projectId, projectId),
          eq(runs.kind, "base"),
          eq(runs.branch, branch),
          inArray(runs.state, active),
          ne(runs.id, beforeRunId),
          ...(selfCreatedAt ? [lt(runs.createdAt, selfCreatedAt)] : []),
        ),
      );
    return rows as RunRow[];
  }

  async lastBaseRunAt(projectId: string, branch: string): Promise<Date | null> {
    const rows = await this.db
      .select({ createdAt: runs.createdAt })
      .from(runs)
      .where(and(eq(runs.projectId, projectId), eq(runs.kind, "base"), eq(runs.branch, branch)))
      .orderBy(desc(runs.createdAt))
      .limit(1);
    return rows[0]?.createdAt ?? null;
  }

  async listStuckRuns(cutoff: Date): Promise<RunRow[]> {
    const active = ["planning", "resolving_base", "executing", "judging", "reporting"];
    const rows = await this.db
      .select()
      .from(runs)
      .where(and(inArray(runs.state, active), lt(runs.updatedAt, cutoff)));
    return rows as RunRow[];
  }

  async deleteExpiredPrCredentials(now: Date): Promise<number> {
    const expired = await this.db
      .select({ id: credentialSets.id })
      .from(credentialSets)
      .where(and(eq(credentialSets.scope, "pr"), lt(credentialSets.expiresAt, now)));
    for (const row of expired) {
      await this.db.delete(credentialSets).where(eq(credentialSets.id, row.id));
    }
    return expired.length;
  }

  async createPaymentConfig(input: {
    projectId: string;
    scope: "project" | "pr";
    prNumber: number | null;
    provider: string;
    cardSecretId: string;
    expiry: string;
    cvcSecretId: string;
    extras: Record<string, unknown>;
    testCardRecognized: boolean;
  }): Promise<string> {
    const id = newId("paymentConfig");
    // one config per (project, scope, prNumber, provider): replace on re-save
    await this.db
      .delete(paymentConfigs)
      .where(
        and(
          eq(paymentConfigs.projectId, input.projectId),
          eq(paymentConfigs.scope, input.scope),
          input.prNumber === null ? isNull(paymentConfigs.prNumber) : eq(paymentConfigs.prNumber, input.prNumber),
          eq(paymentConfigs.provider, input.provider),
        ),
      );
    await this.db.insert(paymentConfigs).values({
      id,
      ...input,
      consentConfirmedAt: new Date(), // the endpoint enforces consent === true
    });
    return id;
  }

  async listPaymentConfigs(projectId: string) {
    const rows = await this.db
      .select({
        id: paymentConfigs.id,
        scope: paymentConfigs.scope,
        prNumber: paymentConfigs.prNumber,
        provider: paymentConfigs.provider,
        expiry: paymentConfigs.expiry,
        testCardRecognized: paymentConfigs.testCardRecognized,
        cardLast4: secrets.last4,
      })
      .from(paymentConfigs)
      .leftJoin(secrets, eq(paymentConfigs.cardSecretId, secrets.id))
      .where(eq(paymentConfigs.projectId, projectId));
    return rows;
  }

  async deletePaymentConfig(id: string): Promise<boolean> {
    const rows = await this.db.delete(paymentConfigs).where(eq(paymentConfigs.id, id)).returning({ id: paymentConfigs.id });
    return rows.length > 0;
  }

  async resolvePaymentConfig(projectId: string, prNumber: number | null) {
    if (prNumber !== null) {
      const pr = await this.db
        .select()
        .from(paymentConfigs)
        .where(
          and(
            eq(paymentConfigs.projectId, projectId),
            eq(paymentConfigs.scope, "pr"),
            eq(paymentConfigs.prNumber, prNumber),
          ),
        )
        .limit(1);
      if (pr[0]) return shapePaymentConfig(pr[0]);
    }
    const project = await this.db
      .select()
      .from(paymentConfigs)
      .where(and(eq(paymentConfigs.projectId, projectId), eq(paymentConfigs.scope, "project")))
      .limit(1);
    return project[0] ? shapePaymentConfig(project[0]) : null;
  }

  async createRecording(input: {
    projectId: string;
    flowName: string | null;
    traceKey: string;
    origin: string;
    status: string;
  }): Promise<string> {
    const id = newId("recording");
    await this.db.insert(recordings).values({
      id,
      projectId: input.projectId,
      flowId: null, // linked when the compiled flow is created (Phase 6)
      flowName: input.flowName,
      traceKey: input.traceKey,
      origin: input.origin,
      status: input.status,
    });
    return id;
  }

  async setRecordingTraceKey(recordingId: string, traceKey: string): Promise<void> {
    await this.db.update(recordings).set({ traceKey }).where(eq(recordings.id, recordingId));
  }

  async getRecording(recordingId: string) {
    const rows = await this.db.select().from(recordings).where(eq(recordings.id, recordingId)).limit(1);
    const r = rows[0];
    return r
      ? {
          id: r.id,
          projectId: r.projectId!,
          flowId: r.flowId,
          flowName: r.flowName,
          traceKey: r.traceKey,
          origin: r.origin,
          status: r.status,
        }
      : null;
  }

  async updateRecording(recordingId: string, patch: { status?: string; flowId?: string | null }): Promise<void> {
    await this.db.update(recordings).set(patch).where(eq(recordings.id, recordingId));
  }

  async listRecordings(projectId: string) {
    const rows = await this.db
      .select()
      .from(recordings)
      .where(eq(recordings.projectId, projectId))
      .orderBy(desc(recordings.createdAt));
    return rows.map((r) => ({
      id: r.id,
      flowId: r.flowId,
      flowName: r.flowName,
      status: r.status,
      traceKey: r.traceKey,
    }));
  }

  // ── flows & versions (Phase 6) ──────────────────────────────────────────

  async createFlow(input: {
    id: string;
    projectId: string;
    name: string;
    tier: string;
    persona: string | null;
  }): Promise<void> {
    await this.db.insert(flows).values(input);
  }

  async archiveFlow(flowId: string): Promise<void> {
    await this.db.update(flows).set({ archived: true }).where(eq(flows.id, flowId));
  }

  async insertFlowVersion(input: {
    flowId: string;
    spec: FlowSpec;
    status: string;
    branch: string;
    source: string;
    sourceRecordingId?: string | null;
    supersedesVersionId?: string | null;
    compilationReport?: Record<string, unknown> | null;
    approvedFromRunId?: string | null;
  }): Promise<string> {
    const id = newId("flowSpecVersion");
    await this.db.insert(flowSpecVersions).values({
      id,
      flowId: input.flowId,
      spec: input.spec,
      status: input.status,
      branch: input.branch,
      source: input.source,
      sourceRecordingId: input.sourceRecordingId ?? null,
      supersedesVersionId: input.supersedesVersionId ?? null,
      approvedFromRunId: input.approvedFromRunId ?? null,
      compilationReport: input.compilationReport ?? null,
    });
    return id;
  }

  async getFlowVersion(versionId: string) {
    const rows = await this.db
      .select()
      .from(flowSpecVersions)
      .where(eq(flowSpecVersions.id, versionId))
      .limit(1);
    const r = rows[0];
    return r
      ? {
          id: r.id,
          flowId: r.flowId!,
          spec: r.spec,
          status: r.status,
          branch: r.branch,
          sourceRecordingId: r.sourceRecordingId,
          compilationReport: r.compilationReport,
        }
      : null;
  }

  async listDraftVersions(projectId: string) {
    const rows = await this.db
      .select({
        id: flowSpecVersions.id,
        flowId: flowSpecVersions.flowId,
        flowName: flows.name,
        branch: flowSpecVersions.branch,
        sourceRecordingId: flowSpecVersions.sourceRecordingId,
      })
      .from(flowSpecVersions)
      .innerJoin(flows, eq(flowSpecVersions.flowId, flows.id))
      .where(and(eq(flows.projectId, projectId), eq(flowSpecVersions.status, "draft")))
      .orderBy(desc(flowSpecVersions.createdAt));
    return rows.map((r) => ({ ...r, flowId: r.flowId! }));
  }

  async setVersionStatus(versionId: string, status: string): Promise<void> {
    await this.db.update(flowSpecVersions).set({ status }).where(eq(flowSpecVersions.id, versionId));
  }

  async promoteVersionToOfficial(versionId: string): Promise<void> {
    const version = await this.getFlowVersion(versionId);
    if (!version) throw new Error(`version not found: ${versionId}`);
    // archive the previous official/quarantined for (flow, branch) — the partial
    // unique index allows exactly one current version (doc 08)
    await this.db
      .update(flowSpecVersions)
      .set({ status: "archived" })
      .where(
        and(
          eq(flowSpecVersions.flowId, version.flowId),
          eq(flowSpecVersions.branch, version.branch),
          inArray(flowSpecVersions.status, ["official", "quarantined"]),
        ),
      );
    await this.db.update(flowSpecVersions).set({ status: "official" }).where(eq(flowSpecVersions.id, versionId));
  }

  async updateVersionReport(versionId: string, patch: Record<string, unknown>): Promise<void> {
    const version = await this.getFlowVersion(versionId);
    if (!version) return;
    await this.db
      .update(flowSpecVersions)
      .set({ compilationReport: { ...(version.compilationReport ?? {}), ...patch } })
      .where(eq(flowSpecVersions.id, versionId));
  }

  async upsertBaseCache(specVersionId: string, baseSha: string, resultId: string): Promise<void> {
    await this.db
      .insert(baseResultCache)
      .values({ specVersionId, baseSha, resultId })
      .onConflictDoUpdate({
        target: [baseResultCache.specVersionId, baseResultCache.baseSha],
        set: { resultId },
      });
  }

  async insertVerdict(input: {
    runId: string;
    flowId: string;
    verdict: VerdictKind;
    humanCopy: string;
    evidence: Record<string, unknown>;
    confidence?: number | null;
    rationale?: string | null;
    approvalState?: string | null;
  }): Promise<string> {
    const id = newId("verdict");
    await this.db.insert(verdicts).values({
      id,
      runId: input.runId,
      flowId: input.flowId,
      verdict: input.verdict,
      humanCopy: input.humanCopy,
      evidence: input.evidence,
      confidence: input.confidence ?? null,
      rationale: input.rationale ?? null,
      approvalState: input.approvalState ?? null,
    });
    return id;
  }

  async getVerdictById(verdictId: string) {
    const rows = await this.db
      .select({
        id: verdicts.id,
        runId: verdicts.runId,
        flowId: verdicts.flowId,
        verdict: verdicts.verdict,
        humanCopy: verdicts.humanCopy,
        rationale: verdicts.rationale,
        approvalState: verdicts.approvalState,
        pendingVersionId: verdicts.pendingVersionId,
      })
      .from(verdicts)
      .where(eq(verdicts.id, verdictId))
      .limit(1);
    const r = rows[0];
    return r ? { ...r, runId: r.runId!, flowId: r.flowId! } : null;
  }

  async setVerdictApproval(
    verdictId: string,
    patch: { approvalState: string; pendingVersionId?: string | null; verdict?: VerdictKind },
  ): Promise<void> {
    await this.db
      .update(verdicts)
      .set({
        approvalState: patch.approvalState,
        ...(patch.pendingVersionId !== undefined ? { pendingVersionId: patch.pendingVersionId } : {}),
        ...(patch.verdict ? { verdict: patch.verdict } : {}),
      })
      .where(eq(verdicts.id, verdictId));
  }

  async listAwaitingVerdicts(projectId: string) {
    const rows = await this.db
      .select({
        id: verdicts.id,
        runId: verdicts.runId,
        flowId: verdicts.flowId,
        flowName: flows.name,
        humanCopy: verdicts.humanCopy,
        rationale: verdicts.rationale,
      })
      .from(verdicts)
      .innerJoin(flows, eq(verdicts.flowId, flows.id))
      .where(and(eq(flows.projectId, projectId), eq(verdicts.approvalState, "awaiting")))
      .orderBy(desc(verdicts.createdAt));
    return rows.map((r) => ({ ...r, runId: r.runId!, flowId: r.flowId! }));
  }

  async getOfficialVersion(flowId: string, branch: string) {
    const rows = await this.db
      .select({ id: flowSpecVersions.id, spec: flowSpecVersions.spec })
      .from(flowSpecVersions)
      .where(
        and(
          eq(flowSpecVersions.flowId, flowId),
          eq(flowSpecVersions.branch, branch),
          inArray(flowSpecVersions.status, ["official", "quarantined"]),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  async getRunFlowResult(runId: string, flowId: string, target: "head" | "base") {
    const rows = await this.db
      .select({ id: runFlowResults.id, result: runFlowResults.result })
      .from(runFlowResults)
      .where(
        and(
          eq(runFlowResults.runId, runId),
          eq(runFlowResults.flowId, flowId),
          eq(runFlowResults.target, target),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  async listHealPatches(projectId: string) {
    const rows = await this.db
      .select({
        resultId: runFlowResults.id,
        runId: runFlowResults.runId,
        flowId: runFlowResults.flowId,
        flowName: flows.name,
        result: runFlowResults.result,
      })
      .from(runFlowResults)
      .innerJoin(flows, eq(runFlowResults.flowId, flows.id))
      .where(and(eq(flows.projectId, projectId), eq(runFlowResults.target, "head")))
      .orderBy(desc(runFlowResults.createdAt))
      .limit(50);
    return rows
      .filter((r) => r.result.healAttempt.succeeded && r.result.healAttempt.proposedPatch)
      .slice(0, 10)
      .map((r) => ({
        resultId: r.resultId,
        runId: r.runId!,
        flowId: r.flowId!,
        flowName: r.flowName,
        patch: r.result.healAttempt.proposedPatch,
      }));
  }

  async listActiveRunsForPr(prId: string, beforeRunId: string): Promise<RunRow[]> {
    const current = await this.db
      .select({ createdAt: runs.createdAt })
      .from(runs)
      .where(eq(runs.id, beforeRunId))
      .limit(1);
    if (!current[0]) return [];
    const rows = await this.db
      .select()
      .from(runs)
      .where(
        and(
          eq(runs.prId, prId),
          inArray(runs.state, OPEN_RUN_STATES),
          ne(runs.id, beforeRunId),
          lt(runs.createdAt, current[0].createdAt),
        ),
      );
    return rows as RunRow[];
  }

  async markSuperseded(runId: string, byRunId: string): Promise<void> {
    await this.db
      .update(runs)
      .set({ state: "cancelled", supersededBy: byRunId })
      .where(eq(runs.id, runId));
  }

  async countRunsForPr(prId: string): Promise<number> {
    const rows = await this.db
      .select({ n: count() })
      .from(runs)
      .where(and(eq(runs.prId, prId), eq(runs.kind, "pr")));
    return rows[0]?.n ?? 0;
  }

  // ── credentials & sessions (Phase 4) ────────────────────────────────────

  async createSecret(input: {
    projectId: string;
    kind: string;
    ciphertext: Buffer;
    dekWrapped: Buffer;
    kmsKeyId: string;
    last4: string | null;
  }): Promise<string> {
    const id = newId("secret");
    await this.db.insert(secrets).values({ id, ...input });
    return id;
  }

  async createCredentialSet(input: {
    projectId: string;
    scope: "project" | "pr";
    prNumber: number | null;
    persona: string;
    usernameSecretId: string;
    passwordSecretId: string;
    dataBranchDiffers: boolean;
  }): Promise<CredentialSetRow> {
    // replace an existing set for the same (project, scope, prNumber, persona)
    const existing = await this.db
      .select()
      .from(credentialSets)
      .where(
        and(
          eq(credentialSets.projectId, input.projectId),
          eq(credentialSets.scope, input.scope),
          input.prNumber === null
            ? isNull(credentialSets.prNumber)
            : eq(credentialSets.prNumber, input.prNumber),
          eq(credentialSets.persona, input.persona),
        ),
      )
      .limit(1);
    if (existing[0]) {
      await this.db.delete(credentialSets).where(eq(credentialSets.id, existing[0].id));
    }
    const id = newId("credentialSet");
    await this.db.insert(credentialSets).values({ id, ...input, expiresAt: null });
    return { id, ...input };
  }

  async listCredentialSets(projectId: string): Promise<CredentialSetRow[]> {
    const rows = await this.db
      .select({
        id: credentialSets.id,
        projectId: credentialSets.projectId,
        scope: credentialSets.scope,
        prNumber: credentialSets.prNumber,
        persona: credentialSets.persona,
        usernameSecretId: credentialSets.usernameSecretId,
        passwordSecretId: credentialSets.passwordSecretId,
        dataBranchDiffers: credentialSets.dataBranchDiffers,
        usernameLast4: secrets.last4,
      })
      .from(credentialSets)
      .leftJoin(secrets, eq(credentialSets.usernameSecretId, secrets.id))
      .where(eq(credentialSets.projectId, projectId));
    return rows as CredentialSetRow[];
  }

  async deleteCredentialSet(id: string): Promise<boolean> {
    const deleted = await this.db
      .delete(credentialSets)
      .where(eq(credentialSets.id, id))
      .returning({ id: credentialSets.id });
    return deleted.length > 0;
  }

  async resolveCredentialSet(
    projectId: string,
    persona: string,
    prNumber: number | null,
  ): Promise<CredentialSetRow | null> {
    const notExpired = (row: { expiresAt: Date | null }) =>
      row.expiresAt === null || row.expiresAt > new Date();
    if (prNumber !== null) {
      const prScoped = await this.db
        .select()
        .from(credentialSets)
        .where(
          and(
            eq(credentialSets.projectId, projectId),
            eq(credentialSets.scope, "pr"),
            eq(credentialSets.prNumber, prNumber),
            eq(credentialSets.persona, persona),
          ),
        )
        .limit(1);
      if (prScoped[0] && notExpired(prScoped[0])) return prScoped[0] as CredentialSetRow;
    }
    const projectScoped = await this.db
      .select()
      .from(credentialSets)
      .where(
        and(
          eq(credentialSets.projectId, projectId),
          eq(credentialSets.scope, "project"),
          eq(credentialSets.persona, persona),
        ),
      )
      .limit(1);
    if (projectScoped[0] && notExpired(projectScoped[0])) return projectScoped[0] as CredentialSetRow;
    return null;
  }

  async expirePrScopedCredentials(projectId: string, prNumber: number): Promise<number> {
    const updated = await this.db
      .update(credentialSets)
      .set({ expiresAt: new Date() })
      .where(
        and(
          eq(credentialSets.projectId, projectId),
          eq(credentialSets.scope, "pr"),
          eq(credentialSets.prNumber, prNumber),
        ),
      )
      .returning({ id: credentialSets.id });
    return updated.length;
  }

  async getSessionStateKey(persona: string, deploymentId: string): Promise<string | null> {
    const rows = await this.db
      .select({ s3Key: sessionStates.s3Key })
      .from(sessionStates)
      .where(and(eq(sessionStates.persona, persona), eq(sessionStates.deploymentId, deploymentId)))
      .limit(1);
    return rows[0]?.s3Key ?? null;
  }

  // ── dashboard v0 reads ──────────────────────────────────────────────────

  async listProjects(): Promise<ProjectRow[]> {
    const rows = await this.db
      .select({
        id: projects.id,
        name: projects.name,
        githubRepo: projects.githubRepo,
        installationId: githubInstallations.installationId,
        vercelProjectId: projects.vercelProjectId,
        vercelTeamId: projects.vercelTeamId,
        vercelTokenRef: projects.vercelTokenRef,
        vercelBypassSecretRef: projects.vercelBypassSecretRef,
        baseBranches: projects.baseBranches,
      })
      .from(projects)
      .leftJoin(githubInstallations, eq(projects.githubInstallationId, githubInstallations.id));
    return rows;
  }

  async listRunsForProject(projectId: string, limit: number) {
    const rows = await this.db
      .select({
        id: runs.id,
        projectId: runs.projectId,
        kind: runs.kind,
        state: runs.state,
        prId: runs.prId,
        headSha: runs.headSha,
        headDeploymentId: runs.headDeploymentId,
        branch: runs.branch,
        prNumber: pullRequests.number,
      })
      .from(runs)
      .leftJoin(pullRequests, eq(runs.prId, pullRequests.id))
      .where(eq(runs.projectId, projectId))
      .orderBy(desc(runs.createdAt))
      .limit(limit);
    return rows as Array<RunRow & { prNumber: number | null }>;
  }

  async getRunDetail(runId: string) {
    const run = await this.getRunById(runId);
    if (!run) return null;
    const results = await this.db
      .select({
        id: runFlowResults.id,
        flowId: runFlowResults.flowId,
        target: runFlowResults.target,
        status: runFlowResults.status,
        failureClass: runFlowResults.failureClass,
        failedStepId: runFlowResults.failedStepId,
        fromCache: runFlowResults.fromCache,
        artifacts: runFlowResults.artifacts,
      })
      .from(runFlowResults)
      .where(eq(runFlowResults.runId, runId));
    const verdictRows = await this.db
      .select({ flowId: verdicts.flowId, verdict: verdicts.verdict, humanCopy: verdicts.humanCopy })
      .from(verdicts)
      .where(eq(verdicts.runId, runId));
    return {
      run,
      results: results.map((r) => ({
        id: r.id,
        flowId: r.flowId ?? "",
        target: r.target,
        status: r.status,
        failureClass: r.failureClass,
        failedStepId: r.failedStepId,
        fromCache: r.fromCache,
        artifacts: (r.artifacts ?? {}) as Record<string, string | null>,
      })),
      verdicts: verdictRows.map((v) => ({
        flowId: v.flowId ?? "",
        verdict: v.verdict,
        humanCopy: v.humanCopy,
      })),
    };
  }
}

function shapePaymentConfig(row: {
  provider: string;
  cardSecretId: string | null;
  expiry: string | null;
  cvcSecretId: string | null;
  scope: string;
  extras: Record<string, unknown>;
}) {
  if (!row.cardSecretId || !row.cvcSecretId || !row.expiry) return null;
  return {
    provider: row.provider,
    cardSecretId: row.cardSecretId,
    expiry: row.expiry,
    cvcSecretId: row.cvcSecretId,
    scope: row.scope,
    extras: row.extras,
  };
}
