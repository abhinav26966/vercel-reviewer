import { pino } from "pino";
import type { FlowSpec, RunFlowResult, VerdictKind } from "@flowguard/schemas";
import type { Store, ProjectRow, DeploymentRow, PullRequestRow, RunRow } from "../src/store.js";
import type { HandlerDeps } from "../src/handlers/deps.js";

export class FakeStore implements Store {
  deliveries = new Set<string>();
  installations = new Map<number, string>();
  projects: ProjectRow[] = [];
  deployments: DeploymentRow[] = [];
  pullRequests: PullRequestRow[] = [];
  runs: RunRow[] = [];
  private seq = 0;

  private id(prefix: string) {
    return `${prefix}_${++this.seq}`;
  }

  async markDeliveryProcessed(deliveryId: string) {
    if (this.deliveries.has(deliveryId)) return false;
    this.deliveries.add(deliveryId);
    return true;
  }

  async upsertInstallation(installationId: number, accountLogin: string) {
    this.installations.set(installationId, accountLogin);
  }

  async removeInstallation(installationId: number) {
    this.installations.delete(installationId);
  }

  async getProjectByRepo(repoFullName: string) {
    return this.projects.find((p) => p.githubRepo === repoFullName) ?? null;
  }

  async upsertDeployment(input: {
    projectId: string;
    sha: string;
    url: string;
    environment: string;
    state: string;
    branch?: string | null;
  }): Promise<DeploymentRow> {
    const existing = this.deployments.find(
      (d) => d.projectId === input.projectId && d.url === input.url,
    );
    if (existing) {
      existing.state = input.state;
      return existing;
    }
    const row: DeploymentRow = {
      id: this.id("dep"),
      projectId: input.projectId,
      sha: input.sha,
      url: input.url,
      environment: input.environment,
      state: input.state,
      branch: input.branch ?? null,
    };
    this.deployments.push(row);
    return row;
  }

  async upsertPullRequest(input: {
    projectId: string;
    number: number;
    baseBranch: string;
    state: string;
  }): Promise<PullRequestRow> {
    const existing = this.pullRequests.find(
      (p) => p.projectId === input.projectId && p.number === input.number,
    );
    if (existing) {
      existing.state = input.state;
      existing.baseBranch = input.baseBranch;
      return existing;
    }
    const row: PullRequestRow = {
      id: this.id("pull"),
      projectId: input.projectId,
      number: input.number,
      state: input.state,
      baseBranch: input.baseBranch,
      stickyCommentId: null,
    };
    this.pullRequests.push(row);
    return row;
  }

  async setStickyCommentId(prId: string, commentId: number) {
    const pr = this.pullRequests.find((p) => p.id === prId);
    if (pr) pr.stickyCommentId = commentId;
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
    const existing = this.runs.find(
      (r) =>
        r.projectId === input.projectId &&
        r.kind === input.kind &&
        r.headSha === (input.headSha ?? null) &&
        r.headDeploymentId === (input.headDeploymentId ?? null),
    );
    if (existing) return { run: existing, created: false };
    const run: RunRow = {
      id: this.id("run"),
      projectId: input.projectId,
      kind: input.kind,
      state: input.state,
      prId: input.prId ?? null,
      headSha: input.headSha ?? null,
      headDeploymentId: input.headDeploymentId ?? null,
      branch: input.branch ?? null,
    };
    this.runs.push(run);
    return { run, created: true };
  }

  async upgradeAwaitingRun(input: {
    projectId: string;
    prId: string;
    headSha: string;
    headDeploymentId: string;
  }): Promise<RunRow | null> {
    const run = this.runs.find(
      (r) =>
        r.projectId === input.projectId &&
        r.prId === input.prId &&
        r.kind === "pr" &&
        r.state === "awaiting_deployment" &&
        r.headSha === input.headSha &&
        r.headDeploymentId === null,
    );
    if (!run) return null;
    run.headDeploymentId = input.headDeploymentId;
    run.state = "planning";
    return run;
  }

  async cancelOpenRunsForPr(prId: string): Promise<number> {
    let n = 0;
    for (const r of this.runs) {
      if (r.prId === prId && r.state !== "done" && r.state !== "cancelled") {
        r.state = "cancelled";
        n++;
      }
    }
    return n;
  }

  // ── orchestration (Phase 3) ─────────────────────────────────────────────
  officialFlows: Array<{
    flowId: string;
    flowName: string;
    tier: string;
    specVersionId: string;
    spec: FlowSpec;
    branch: string;
    projectId: string;
  }> = [];
  runFlowResults: Array<{
    id: string;
    runId: string;
    flowId: string;
    specVersionId: string;
    target: "head" | "base";
    result: RunFlowResult;
    fromCache: boolean;
  }> = [];
  baseCache = new Map<string, string>(); // `${specVersionId}:${sha}` → resultId
  verdicts: Array<{ runId: string; flowId: string; verdict: VerdictKind; humanCopy: string }> = [];
  runPatches: Array<{ runId: string; patch: Record<string, unknown> }> = [];
  mergeBaseShas = new Map<string, string | null>(); // runId → mergeBaseSha

  async getRunById(runId: string): Promise<RunRow | null> {
    return this.runs.find((r) => r.id === runId) ?? null;
  }

  async updateRun(runId: string, patch: Parameters<Store["updateRun"]>[1]): Promise<void> {
    this.runPatches.push({ runId, patch: patch as Record<string, unknown> });
    const run = this.runs.find((r) => r.id === runId);
    if (run) {
      if (patch.state) run.state = patch.state;
      if (patch.headDeploymentId !== undefined) run.headDeploymentId = patch.headDeploymentId;
      if (patch.mergeBaseSha !== undefined) this.mergeBaseShas.set(runId, patch.mergeBaseSha);
    }
  }

  async getProjectById(projectId: string): Promise<ProjectRow | null> {
    return this.projects.find((p) => p.id === projectId) ?? null;
  }

  async getPullRequestById(prId: string) {
    const pr = this.pullRequests.find((p) => p.id === prId);
    return pr ? { ...pr, title: `PR ${pr.number}` } : null;
  }

  async getDeploymentById(deploymentId: string): Promise<DeploymentRow | null> {
    return this.deployments.find((d) => d.id === deploymentId) ?? null;
  }

  async getLatestDeploymentForSha(projectId: string, sha: string): Promise<DeploymentRow | null> {
    return (
      [...this.deployments].reverse().find((d) => d.projectId === projectId && d.sha === sha) ?? null
    );
  }

  async listOfficialFlows(projectId: string, branch: string) {
    return this.officialFlows
      .filter((f) => f.projectId === projectId && f.branch === branch)
      .map(({ flowId, flowName, tier, specVersionId, spec }) => ({
        flowId,
        flowName,
        tier,
        specVersionId,
        spec,
      }));
  }

  async getCachedBaseResult(specVersionId: string, baseSha: string) {
    const resultId = this.baseCache.get(`${specVersionId}:${baseSha}`);
    if (!resultId) return null;
    const row = this.runFlowResults.find((r) => r.id === resultId);
    return row ? { resultId, result: row.result, artifacts: row.result.artifacts } : null;
  }

  async insertRunFlowResult(input: {
    runId: string;
    flowId: string;
    specVersionId: string;
    target: "head" | "base";
    result: RunFlowResult;
    fromCache: boolean;
  }): Promise<string> {
    const id = this.id("rfr");
    this.runFlowResults.push({ id, ...input });
    return id;
  }

  async upsertBaseCache(specVersionId: string, baseSha: string, resultId: string): Promise<void> {
    this.baseCache.set(`${specVersionId}:${baseSha}`, resultId);
  }

  async insertVerdict(input: {
    runId: string;
    flowId: string;
    verdict: VerdictKind;
    humanCopy: string;
    evidence: Record<string, unknown>;
  }): Promise<void> {
    this.verdicts.push(input);
  }

  async listActiveRunsForPr(prId: string, beforeRunId: string): Promise<RunRow[]> {
    const open = ["awaiting_deployment", "planning", "resolving_base", "executing", "judging", "reporting"];
    const currentIdx = this.runs.findIndex((r) => r.id === beforeRunId);
    // array order = creation order in the fake
    return this.runs.filter(
      (r, i) => r.prId === prId && r.id !== beforeRunId && i < currentIdx && open.includes(r.state),
    );
  }

  async markSuperseded(runId: string, byRunId: string): Promise<void> {
    const run = this.runs.find((r) => r.id === runId);
    if (run) {
      run.state = "cancelled";
      (run as RunRow & { supersededBy?: string }).supersededBy = byRunId;
    }
  }

  async countRunsForPr(prId: string): Promise<number> {
    return this.runs.filter((r) => r.prId === prId && r.kind === "pr").length;
  }
}

/** Fake installation octokit capturing GitHub-side effects. */
export function fakeOctokit(
  opts: {
    openPrs?: Array<{ number: number; state: string }>;
    /** SHAs that the compare API reports as contained in each branch. */
    branchContains?: Record<string, string[]>;
  } = {},
) {
  const comments: Array<{ id: number; body: string }> = [];
  const statuses: Array<{ sha: string; state: string; description?: string }> = [];
  let nextCommentId = 100;
  const octokit = {
    rest: {
      issues: {
        async listComments() {
          return { data: comments.map((c) => ({ ...c })) };
        },
        async createComment({ body }: { body: string }) {
          const c = { id: nextCommentId++, body };
          comments.push(c);
          return { data: { id: c.id } };
        },
        async updateComment({ comment_id, body }: { comment_id: number; body: string }) {
          const c = comments.find((x) => x.id === comment_id);
          if (!c) throw new Error("404");
          c.body = body;
          return { data: { id: comment_id } };
        },
      },
      repos: {
        async listPullRequestsAssociatedWithCommit() {
          return {
            data: (opts.openPrs ?? []).map((pr) => ({
              number: pr.number,
              state: pr.state,
              title: `PR ${pr.number}`,
              body: null,
              user: { login: "author" },
              head: { ref: "feat", sha: "headsha" },
              base: { ref: "main" },
            })),
          };
        },
        async createCommitStatus(params: { sha: string; state: string; description?: string }) {
          statuses.push({ sha: params.sha, state: params.state, description: params.description });
          return {};
        },
        async compareCommitsWithBasehead({ basehead }: { basehead: string }) {
          const [branch, sha] = basehead.split("...");
          const contained = opts.branchContains?.[branch!] ?? [];
          if (!contained.length) throw new Error("404 unknown branch/sha");
          return { data: { status: contained.includes(sha!) ? "identical" : "diverged" } };
        },
      },
    },
  };
  return { octokit, comments, statuses };
}

export function makeDeps(
  store: FakeStore,
  octokit: ReturnType<typeof fakeOctokit>["octokit"],
  extra: Partial<HandlerDeps> = {},
): HandlerDeps {
  return {
    store,
    logger: pino({ level: "silent" }),
    githubApp: {
      async getInstallationOctokit() {
        return octokit as never;
      },
    },
    ...extra,
  };
}

export const boundProject: ProjectRow = {
  id: "prj_1",
  name: "demo",
  githubRepo: "founder/flowguard",
  installationId: 555,
  vercelProjectId: "prj_vercel_1",
  vercelTeamId: null,
  vercelTokenRef: null,
  vercelBypassSecretRef: null,
  baseBranches: ["main"],
};
