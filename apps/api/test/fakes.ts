import { pino } from "pino";
import type { FlowSpec, RunFlowResult, VerdictKind } from "@flowguard/schemas";
import type {
  Store,
  ProjectRow,
  DeploymentRow,
  PullRequestRow,
  RunRow,
  CredentialSetRow,
} from "../src/store.js";
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
  verdicts: Array<{
    id?: string;
    runId: string;
    flowId: string;
    verdict: VerdictKind;
    humanCopy: string;
    confidence?: number | null;
    rationale?: string | null;
    approvalState?: string | null;
    pendingVersionId?: string | null;
  }> = [];
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
    const existing = this.runFlowResults.find(
      (r) => r.runId === input.runId && r.flowId === input.flowId && r.target === input.target,
    );
    if (existing) {
      Object.assign(existing, input);
      return existing.id;
    }
    const id = this.id("rfr");
    this.runFlowResults.push({ id, ...input });
    return id;
  }

  async deleteVerdictsForRun(runId: string): Promise<void> {
    this.verdicts = this.verdicts.filter((v) => v.runId !== runId);
  }

  perfBaselineRows: Array<{ flowId: string; branch: string; sha: string; stepKey: string; medianMs: number; samples: number }> = [];

  async upsertPerfBaseline(input: { flowId: string; branch: string; sha: string; stepKey: string; medianMs: number; samples: number }) {
    this.perfBaselineRows = this.perfBaselineRows.filter(
      (r) => !(r.flowId === input.flowId && r.branch === input.branch && r.sha === input.sha && r.stepKey === input.stepKey),
    );
    this.perfBaselineRows.push(input);
  }

  coverageMapRows: Array<{ flowId: string; branch: string; sha: string; files: string[]; apiRoutes: string[] }> = [];

  async getLatestCoverageMap(flowId: string, branch: string) {
    const rows = this.coverageMapRows.filter((r) => r.flowId === flowId && r.branch === branch);
    const last = rows[rows.length - 1];
    return last ? { sha: last.sha, files: last.files, apiRoutes: last.apiRoutes } : null;
  }

  async upsertCoverageMap(input: { flowId: string; branch: string; sha: string; files: string[]; apiRoutes: string[] }) {
    this.coverageMapRows = this.coverageMapRows.filter(
      (r) => !(r.flowId === input.flowId && r.branch === input.branch && r.sha === input.sha),
    );
    this.coverageMapRows.push(input);
  }

  async setFlowTier(flowId: string, tier: "smoke" | "standard") {
    const f = this.officialFlows.find((x) => x.flowId === flowId);
    if (f) f.tier = tier;
  }

  async archiveOtherPendings(flowId: string, branch: string, exceptVersionId: string) {
    for (const v of this.versionRows) {
      if (v.flowId === flowId && v.branch === branch && v.status === "pending" && v.id !== exceptVersionId) {
        v.status = "archived";
      }
    }
  }

  async listFlows(projectId: string) {
    return this.officialFlows
      .filter((f) => f.projectId === projectId)
      .map((f) => ({ id: f.flowId, name: f.flowName, tier: f.tier, archived: false }));
  }

  // ── recordings (Phase 5) ────────────────────────────────────────────────
  recordings: Array<{
    id: string;
    projectId: string;
    flowName: string | null;
    traceKey: string;
    origin: string;
    status: string;
  }> = [];

  async createRecording(input: {
    projectId: string;
    flowName: string | null;
    traceKey: string;
    origin: string;
    status: string;
  }): Promise<string> {
    const id = this.id("rec");
    this.recordings.push({ id, ...input });
    return id;
  }

  async setRecordingTraceKey(recordingId: string, traceKey: string): Promise<void> {
    const r = this.recordings.find((x) => x.id === recordingId);
    if (r) r.traceKey = traceKey;
  }

  async getRecording(recordingId: string) {
    const r = this.recordings.find((x) => x.id === recordingId);
    return r ? { ...r, flowId: (r as { flowId?: string | null }).flowId ?? null, origin: r.origin ?? null } : null;
  }

  async updateRecording(recordingId: string, patch: { status?: string; flowId?: string | null }) {
    const r = this.recordings.find((x) => x.id === recordingId) as
      | (typeof this.recordings)[number] & { flowId?: string | null }
      | undefined;
    if (!r) return;
    if (patch.status) r.status = patch.status;
    if (patch.flowId !== undefined) r.flowId = patch.flowId;
  }

  async listRecordings(projectId: string) {
    return this.recordings
      .filter((r) => r.projectId === projectId)
      .map((r) => ({
        id: r.id,
        flowId: (r as { flowId?: string | null }).flowId ?? null,
        flowName: r.flowName,
        status: r.status,
        traceKey: r.traceKey,
      }));
  }

  // ── flows & versions (Phase 6) ──────────────────────────────────────────
  flowRows: Array<{ id: string; projectId: string; name: string; tier: string; persona: string | null; archived: boolean }> = [];
  versionRows: Array<{
    id: string;
    flowId: string;
    spec: FlowSpec;
    status: string;
    branch: string;
    source: string;
    sourceRecordingId: string | null;
    compilationReport: Record<string, unknown> | null;
  }> = [];

  async createFlow(input: { id: string; projectId: string; name: string; tier: string; persona: string | null }) {
    this.flowRows.push({ ...input, archived: false });
  }

  async archiveFlow(flowId: string) {
    const f = this.flowRows.find((x) => x.id === flowId);
    if (f) f.archived = true;
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
    const id = this.id("fsv");
    this.versionRows.push({
      id,
      flowId: input.flowId,
      spec: input.spec,
      status: input.status,
      branch: input.branch,
      source: input.source,
      sourceRecordingId: input.sourceRecordingId ?? null,
      compilationReport: {
        ...(input.compilationReport ?? {}),
        ...(input.approvedFromRunId ? { approvedFromRunId: input.approvedFromRunId } : {}),
        ...(input.supersedesVersionId ? { supersedesVersionId: input.supersedesVersionId } : {}),
      },
    });
    return id;
  }

  async getFlowVersion(versionId: string) {
    const r = this.versionRows.find((v) => v.id === versionId);
    return r ? { ...r } : null;
  }

  async listDraftVersions(projectId: string) {
    return this.versionRows
      .filter((v) => v.status === "draft" && this.flowRows.some((f) => f.id === v.flowId && f.projectId === projectId))
      .map((v) => ({
        id: v.id,
        flowId: v.flowId,
        flowName: this.flowRows.find((f) => f.id === v.flowId)?.name ?? "?",
        branch: v.branch,
        sourceRecordingId: v.sourceRecordingId,
      }));
  }

  async setVersionStatus(versionId: string, status: string) {
    const v = this.versionRows.find((x) => x.id === versionId);
    if (v) v.status = status;
  }

  async promoteVersionToOfficial(versionId: string) {
    const v = this.versionRows.find((x) => x.id === versionId);
    if (!v) throw new Error("version not found");
    for (const o of this.versionRows) {
      if (o.flowId === v.flowId && o.branch === v.branch && ["official", "quarantined"].includes(o.status)) {
        o.status = "archived";
      }
    }
    v.status = "official";
  }

  async updateVersionReport(versionId: string, patch: Record<string, unknown>) {
    const v = this.versionRows.find((x) => x.id === versionId);
    if (v) v.compilationReport = { ...(v.compilationReport ?? {}), ...patch };
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
    confidence?: number | null;
    rationale?: string | null;
    approvalState?: string | null;
  }): Promise<string> {
    const id = this.id("vrd");
    this.verdicts.push({ ...input, id });
    return id;
  }

  async getVerdictById(verdictId: string) {
    const v = this.verdicts.find((x) => x.id === verdictId);
    return v
      ? {
          id: v.id!,
          runId: v.runId,
          flowId: v.flowId,
          verdict: v.verdict as string,
          humanCopy: v.humanCopy,
          rationale: v.rationale ?? null,
          approvalState: v.approvalState ?? null,
          pendingVersionId: v.pendingVersionId ?? null,
        }
      : null;
  }

  async setVerdictApproval(
    verdictId: string,
    patch: { approvalState: string; pendingVersionId?: string | null; verdict?: VerdictKind },
  ): Promise<void> {
    const v = this.verdicts.find((x) => x.id === verdictId);
    if (!v) return;
    v.approvalState = patch.approvalState;
    if (patch.pendingVersionId !== undefined) v.pendingVersionId = patch.pendingVersionId;
    if (patch.verdict) v.verdict = patch.verdict;
  }

  async listAwaitingVerdicts(projectId: string) {
    return this.verdicts
      .filter(
        (v) =>
          v.approvalState === "awaiting" &&
          (this.officialFlows.some((f) => f.flowId === v.flowId && f.projectId === projectId) ||
            this.flowRows.some((f) => f.id === v.flowId && f.projectId === projectId)),
      )
      .map((v) => ({
        id: v.id!,
        runId: v.runId,
        flowId: v.flowId,
        flowName:
          this.officialFlows.find((f) => f.flowId === v.flowId)?.flowName ??
          this.flowRows.find((f) => f.id === v.flowId)?.name ??
          "?",
        humanCopy: v.humanCopy,
        rationale: v.rationale ?? null,
      }));
  }

  async getOfficialVersion(flowId: string, branch: string) {
    const v = this.versionRows.find(
      (x) => x.flowId === flowId && x.branch === branch && ["official", "quarantined"].includes(x.status),
    );
    if (v) return { id: v.id, spec: v.spec };
    const f = this.officialFlows.find((x) => x.flowId === flowId && x.branch === branch);
    return f ? { id: f.specVersionId, spec: f.spec } : null;
  }

  async getRunFlowResult(runId: string, flowId: string, target: "head" | "base") {
    const r = this.runFlowResults.find((x) => x.runId === runId && x.flowId === flowId && x.target === target);
    return r ? { id: r.id, result: r.result } : null;
  }

  alertRows: Array<{ id: string; projectId: string; kind: string; payload: Record<string, unknown>; acknowledgedAt: Date | null; createdAt: Date }> = [];

  async listBaseSuite(projectId: string, branch: string) {
    const flows = new Map<string, { flowId: string; flowName: string; tier: string }>();
    for (const f of this.officialFlows.filter((x) => x.projectId === projectId && x.branch === branch)) {
      flows.set(f.flowId, { flowId: f.flowId, flowName: f.flowName, tier: f.tier });
    }
    for (const v of this.versionRows) {
      const f = this.flowRows.find((x) => x.id === v.flowId && x.projectId === projectId);
      if (f && !f.archived) flows.set(f.id, { flowId: f.id, flowName: f.name, tier: f.tier });
    }
    const suite = [];
    for (const f of flows.values()) {
      const official =
        this.versionRows.find(
          (v) => v.flowId === f.flowId && v.branch === branch && ["official", "quarantined"].includes(v.status),
        ) ??
        (() => {
          const o = this.officialFlows.find((x) => x.flowId === f.flowId && x.branch === branch);
          return o ? { id: o.specVersionId, status: "official", spec: o.spec } : null;
        })();
      if (!official) continue;
      // newest pending wins (array order = creation order in the fake)
      const pending = [...this.versionRows]
        .reverse()
        .find((v) => v.flowId === f.flowId && v.branch === branch && v.status === "pending");
      suite.push({
        flowId: f.flowId,
        flowName: f.flowName,
        tier: f.tier,
        official: { versionId: official.id, status: official.status, spec: official.spec },
        pending: pending ? { versionId: pending.id, spec: pending.spec } : null,
      });
    }
    return suite;
  }

  async listQuarantinedFlows(projectId: string, branch: string) {
    return this.versionRows
      .filter(
        (v) =>
          v.status === "quarantined" &&
          v.branch === branch &&
          (this.officialFlows.some((f) => f.flowId === v.flowId && f.projectId === projectId) ||
            this.flowRows.some((f) => f.id === v.flowId && f.projectId === projectId)),
      )
      .map((v) => ({
        flowId: v.flowId,
        flowName:
          this.officialFlows.find((f) => f.flowId === v.flowId)?.flowName ??
          this.flowRows.find((f) => f.id === v.flowId)?.name ??
          "?",
        quarantinedSha: ((v.compilationReport ?? {}).quarantinedSha as string) ?? null,
      }));
  }

  async createAlert(input: { projectId: string; kind: string; payload: Record<string, unknown> }) {
    const id = this.id("alr");
    this.alertRows.push({ id, ...input, acknowledgedAt: null, createdAt: new Date() });
    return id;
  }

  async listAlerts(projectId: string) {
    return this.alertRows
      .filter((a) => a.projectId === projectId && !a.acknowledgedAt)
      .map((a) => ({ id: a.id, kind: a.kind, payload: a.payload, createdAt: a.createdAt }));
  }

  async acknowledgeAlerts(projectId: string, kind: string, flowId?: string) {
    for (const a of this.alertRows) {
      if (a.projectId === projectId && a.kind === kind && !a.acknowledgedAt && (!flowId || a.payload.flowId === flowId)) {
        a.acknowledgedAt = new Date();
      }
    }
  }

  async listActiveBaseRuns(projectId: string, branch: string, beforeRunId: string): Promise<RunRow[]> {
    const active = ["planning", "resolving_base", "executing", "judging", "reporting"];
    const idx = this.runs.findIndex((r) => r.id === beforeRunId);
    return this.runs.filter(
      (r, i) =>
        r.projectId === projectId && r.kind === "base" && r.branch === branch && r.id !== beforeRunId && i < idx && active.includes(r.state),
    );
  }

  lastBaseRunTimes = new Map<string, Date>(); // `${projectId}:${branch}`

  async lastBaseRunAt(projectId: string, branch: string): Promise<Date | null> {
    return this.lastBaseRunTimes.get(`${projectId}:${branch}`) ?? null;
  }

  stuckRuns: RunRow[] = [];

  async listStuckRuns(): Promise<RunRow[]> {
    return this.stuckRuns;
  }

  expiredCredentialCount = 0;

  async deleteExpiredPrCredentials(): Promise<number> {
    return this.expiredCredentialCount;
  }

  paymentConfigRows: Array<{
    id: string;
    projectId: string;
    scope: "project" | "pr";
    prNumber: number | null;
    provider: string;
    cardSecretId: string;
    expiry: string;
    cvcSecretId: string;
    extras: Record<string, unknown>;
    testCardRecognized: boolean;
  }> = [];

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
    this.paymentConfigRows = this.paymentConfigRows.filter(
      (r) =>
        !(
          r.projectId === input.projectId &&
          r.scope === input.scope &&
          r.prNumber === input.prNumber &&
          r.provider === input.provider
        ),
    );
    const id = this.id("pay");
    this.paymentConfigRows.push({ id, ...input });
    return id;
  }

  async listPaymentConfigs(projectId: string) {
    return this.paymentConfigRows
      .filter((r) => r.projectId === projectId)
      .map((r) => ({
        id: r.id,
        scope: r.scope,
        prNumber: r.prNumber,
        provider: r.provider,
        cardLast4: null,
        expiry: r.expiry,
        testCardRecognized: r.testCardRecognized,
      }));
  }

  async deletePaymentConfig(id: string): Promise<boolean> {
    const before = this.paymentConfigRows.length;
    this.paymentConfigRows = this.paymentConfigRows.filter((r) => r.id !== id);
    return this.paymentConfigRows.length < before;
  }

  async resolvePaymentConfig(projectId: string, prNumber: number | null) {
    const pick =
      (prNumber !== null
        ? this.paymentConfigRows.find((r) => r.projectId === projectId && r.scope === "pr" && r.prNumber === prNumber)
        : undefined) ?? this.paymentConfigRows.find((r) => r.projectId === projectId && r.scope === "project");
    return pick
      ? {
          provider: pick.provider,
          cardSecretId: pick.cardSecretId,
          expiry: pick.expiry,
          cvcSecretId: pick.cvcSecretId,
          scope: pick.scope,
          extras: pick.extras,
        }
      : null;
  }

  async listHealPatches(projectId: string) {
    return this.runFlowResults
      .filter(
        (r) =>
          r.target === "head" &&
          r.result.healAttempt.succeeded &&
          r.result.healAttempt.proposedPatch &&
          this.officialFlows.some((f) => f.flowId === r.flowId && f.projectId === projectId),
      )
      .slice(0, 10)
      .map((r) => ({
        resultId: r.id,
        runId: r.runId,
        flowId: r.flowId,
        flowName: this.officialFlows.find((f) => f.flowId === r.flowId)?.flowName ?? "?",
        patch: r.result.healAttempt.proposedPatch,
      }));
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

  // ── credentials & sessions (Phase 4) ────────────────────────────────────
  secrets: Array<{ id: string; projectId: string; kind: string; last4: string | null }> = [];
  credentialSets: Array<CredentialSetRow & { expiresAt: Date | null }> = [];
  sessionKeys = new Map<string, string>(); // `${persona}:${deploymentId}` → s3Key

  async createSecret(input: {
    projectId: string;
    kind: string;
    ciphertext: Buffer;
    dekWrapped: Buffer;
    kmsKeyId: string;
    last4: string | null;
  }): Promise<string> {
    const id = this.id("sec");
    this.secrets.push({ id, projectId: input.projectId, kind: input.kind, last4: input.last4 });
    return id;
  }

  async createCredentialSet(
    input: Omit<CredentialSetRow, "id" | "usernameLast4">,
  ): Promise<CredentialSetRow> {
    this.credentialSets = this.credentialSets.filter(
      (c) =>
        !(
          c.projectId === input.projectId &&
          c.scope === input.scope &&
          c.prNumber === input.prNumber &&
          c.persona === input.persona
        ),
    );
    const row = { id: this.id("crd"), ...input, expiresAt: null };
    this.credentialSets.push(row);
    return row;
  }

  async listCredentialSets(projectId: string): Promise<CredentialSetRow[]> {
    return this.credentialSets.filter((c) => c.projectId === projectId);
  }

  async deleteCredentialSet(id: string): Promise<boolean> {
    const before = this.credentialSets.length;
    this.credentialSets = this.credentialSets.filter((c) => c.id !== id);
    return this.credentialSets.length < before;
  }

  async resolveCredentialSet(
    projectId: string,
    persona: string,
    prNumber: number | null,
  ): Promise<CredentialSetRow | null> {
    const live = (c: { expiresAt: Date | null }) => c.expiresAt === null || c.expiresAt > new Date();
    if (prNumber !== null) {
      const pr = this.credentialSets.find(
        (c) =>
          c.projectId === projectId &&
          c.scope === "pr" &&
          c.prNumber === prNumber &&
          c.persona === persona &&
          live(c),
      );
      if (pr) return pr;
    }
    return (
      this.credentialSets.find(
        (c) => c.projectId === projectId && c.scope === "project" && c.persona === persona && live(c),
      ) ?? null
    );
  }

  async expirePrScopedCredentials(projectId: string, prNumber: number): Promise<number> {
    let n = 0;
    for (const c of this.credentialSets) {
      if (c.projectId === projectId && c.scope === "pr" && c.prNumber === prNumber) {
        c.expiresAt = new Date(Date.now() - 1);
        n++;
      }
    }
    return n;
  }

  async getSessionStateKey(persona: string, deploymentId: string): Promise<string | null> {
    return this.sessionKeys.get(`${persona}:${deploymentId}`) ?? null;
  }

  // ── dashboard v0 reads ──────────────────────────────────────────────────
  async listProjects(): Promise<ProjectRow[]> {
    return this.projects;
  }

  async listRunsForProject(projectId: string, limit: number) {
    return this.runs
      .filter((r) => r.projectId === projectId)
      .slice(-limit)
      .reverse()
      .map((r) => ({
        ...r,
        prNumber: this.pullRequests.find((p) => p.id === r.prId)?.number ?? null,
      }));
  }

  async getRunDetail(runId: string) {
    const run = await this.getRunById(runId);
    if (!run) return null;
    return {
      run,
      results: this.runFlowResults
        .filter((r) => r.runId === runId)
        .map((r) => ({
          id: r.id,
          flowId: r.flowId,
          target: r.target as string,
          status: r.result.status,
          failureClass: r.result.failureClass,
          failedStepId: r.result.failedStepId,
          fromCache: r.fromCache,
          artifacts: r.result.artifacts,
        })),
      verdicts: this.verdicts
        .filter((v) => v.runId === runId)
        .map((v) => ({ flowId: v.flowId, verdict: v.verdict as string, humanCopy: v.humanCopy })),
    };
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
      pulls: {
        async get({ pull_number }: { pull_number: number }) {
          return {
            data: {
              number: pull_number,
              title: `PR ${pull_number}`,
              body: "PR body",
              state: "open",
              head: { ref: "feat", sha: "headsha" },
              base: { ref: "main" },
            },
          };
        },
        async listCommits() {
          return { data: [{ commit: { message: "a commit message" } }] };
        },
      },
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
