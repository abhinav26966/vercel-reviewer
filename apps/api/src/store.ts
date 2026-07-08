import { and, count, desc, eq, inArray, isNull, ne } from "drizzle-orm";
import type { Db } from "@flowguard/db";
import {
  baseResultCache,
  deployments,
  flowSpecVersions,
  flows,
  githubInstallations,
  projects,
  pullRequests,
  runFlowResults,
  runs,
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
  /** Runs for the same PR still in flight (any non-terminal state), excluding one. */
  listActiveRunsForPr(prId: string, excludeRunId: string): Promise<RunRow[]>;
  markSuperseded(runId: string, byRunId: string): Promise<void>;
  countRunsForPr(prId: string): Promise<number>;
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
    const id = newId("runFlowResult");
    await this.db.insert(runFlowResults).values({
      id,
      runId: input.runId,
      flowId: input.flowId,
      specVersionId: input.specVersionId,
      target: input.target,
      status: input.result.status,
      failureClass: input.result.failureClass,
      failedStepId: input.result.failedStepId,
      result: input.result,
      artifacts: input.result.artifacts,
      fromCache: input.fromCache,
    });
    return id;
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

  async listActiveRunsForPr(prId: string, excludeRunId: string): Promise<RunRow[]> {
    const rows = await this.db
      .select()
      .from(runs)
      .where(and(eq(runs.prId, prId), inArray(runs.state, OPEN_RUN_STATES), ne(runs.id, excludeRunId)));
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
}
