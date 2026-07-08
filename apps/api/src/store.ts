import { and, count, desc, eq, inArray, isNull, lt, ne } from "drizzle-orm";
import type { Db } from "@flowguard/db";
import {
  baseResultCache,
  credentialSets,
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
    kind: "pr" | "base";
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
  getPullRequestById(prId: string): Promise<(PullRequestRow & { title: string | null }) | null>;
  getDeploymentById(deploymentId: string): Promise<DeploymentRow | null>;
  getLatestDeploymentForSha(projectId: string, sha: string): Promise<DeploymentRow | null>;
  /** Non-archived flows with their official spec version for a branch. */
  listOfficialFlows(
    projectId: string,
    branch: string,
  ): Promise<Array<{ flowId: string; flowName: string; tier: string; specVersionId: string; spec: FlowSpec }>>;
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
  }): Promise<void>;
  /** Reruns replace a run's verdicts wholesale. */
  deleteVerdictsForRun(runId: string): Promise<void>;

  // ── recordings (Phase 5) ────────────────────────────────────────────────
  createRecording(input: {
    projectId: string;
    flowName: string | null;
    traceKey: string;
    origin: string;
    status: string;
  }): Promise<string>;
  setRecordingTraceKey(recordingId: string, traceKey: string): Promise<void>;
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
      })
      .from(projects)
      .leftJoin(githubInstallations, eq(projects.githubInstallationId, githubInstallations.id))
      .where(eq(projects.id, projectId))
      .limit(1);
    return rows[0] ?? null;
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
  }): Promise<void> {
    await this.db.insert(verdicts).values({
      id: newId("verdict"),
      runId: input.runId,
      flowId: input.flowId,
      verdict: input.verdict,
      humanCopy: input.humanCopy,
      evidence: input.evidence,
    });
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
