import Fastify from "fastify";
import multipart from "@fastify/multipart";
import type { Logger } from "pino";
import { verifyWebhookSignature } from "@flowguard/github";
import { isFlowGuardError } from "@flowguard/shared";
import { createPendingVersion } from "./orchestrator/pending-version.js";
import { handleDevToolsImport, handleRecordingUpload, type RecordingDeps } from "./recordings/service.js";
import type { DevToolsRecording } from "./recordings/devtools-import.js";
import type { HandlerDeps } from "./handlers/deps.js";
import { handleDeploymentStatus } from "./handlers/deployment-status.js";
import { handleInstallation } from "./handlers/installation.js";
import { handleIssueComment } from "./handlers/issue-comment.js";
import { handlePullRequest } from "./handlers/pull-request.js";
import type {
  DeploymentStatusEvent,
  InstallationEvent,
  IssueCommentEvent,
  PullRequestEvent,
} from "./webhook-types.js";

export interface AppConfig {
  webhookSecret: string;
  deps: HandlerDeps;
  logger: Logger;
  /** Artifact redirect endpoint (doc 05 §6 presigned links); absent in some tests. */
  artifacts?: {
    verifySig: (s3Key: string, sig: string) => boolean;
    presign: (s3Key: string) => Promise<string>;
    signKey: (s3Key: string) => string;
  };
  /** Encrypts + stores a plaintext in the vault, returns the sec_* ref. */
  storeSecret?: (projectId: string, kind: string, plaintext: string) => Promise<string>;
  /** Recording bundle persistence (S3 put); absent in some tests. */
  recordings?: Pick<RecordingDeps, "putObject"> & {
    getObject?: (key: string) => Promise<Buffer>;
  };
  /** Compiler triggers (Phase 6); absent in some tests. */
  compiler?: {
    enqueueCompile: (recordingId: string) => Promise<void>;
    enqueueValidate: (versionId: string) => Promise<void>;
    /** Plain-language authoring (doc 03 B3): description → draft spec. */
    draftFromDescription?: (projectId: string, name: string, description: string) => Promise<{ flowId: string; versionId: string }>;
  };
  /** Manual base-run trigger (doc 05 §5); Phase 10. */
  startBaseRun?: (projectId: string, branch: string) => Promise<string | null>;
}

export type ApiApp = ReturnType<typeof buildApp>;

export function buildApp(config: AppConfig) {
  const app = Fastify({ loggerInstance: config.logger });

  // keep the raw body: signatures verify over bytes, not parsed JSON
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
    done(null, body);
  });
  void app.register(multipart, { limits: { fileSize: 100 * 1024 * 1024 } });

  app.get("/healthz", async () => ({ ok: true }));

  // local-dev CORS for the dashboard (org auth arrives in Phase 13)
  app.addHook("onSend", async (_req, reply) => {
    reply.header("access-control-allow-origin", "*");
    reply.header("access-control-allow-methods", "GET,POST,PATCH,DELETE,OPTIONS");
    reply.header("access-control-allow-headers", "content-type");
  });
  app.options("/*", async (_req, reply) => reply.code(204).send());

  // ── dashboard v0 API (doc 09 Phase 4 task 6) ──────────────────────────────
  const store = () => config.deps.store;

  app.get("/api/projects", async () => {
    const projects = await store().listProjects();
    return projects.map((p) => ({
      id: p.id,
      name: p.name,
      githubRepo: p.githubRepo,
      baseBranches: p.baseBranches,
    }));
  });

  app.get("/api/projects/:id/runs", async (req) => {
    const { id } = req.params as { id: string };
    return store().listRunsForProject(id, 30);
  });

  app.get("/api/runs/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const detail = await store().getRunDetail(id);
    if (!detail) return reply.code(404).send({ error: "run not found" });
    // pre-signed artifact links for the viewer
    const sign = config.artifacts?.signKey;
    return {
      ...detail,
      results: detail.results.map((r) => ({
        ...r,
        artifactLinks: sign
          ? Object.fromEntries(
              Object.entries(r.artifacts)
                .filter(([, v]) => v)
                .map(([k, v]) => [k, `/artifacts?key=${encodeURIComponent(v!)}&sig=${sign(v!)}`]),
            )
          : {},
      })),
    };
  });

  app.get("/api/projects/:id/credentials", async (req) => {
    const { id } = req.params as { id: string };
    const sets = await store().listCredentialSets(id);
    // never return secret refs to the browser — display metadata only
    return sets.map((s) => ({
      id: s.id,
      scope: s.scope,
      prNumber: s.prNumber,
      persona: s.persona,
      usernameLast4: s.usernameLast4 ?? null,
      dataBranchDiffers: s.dataBranchDiffers,
    }));
  });

  app.post("/api/projects/:id/credentials", async (req, reply) => {
    if (!config.storeSecret) return reply.code(500).send({ error: "vault not configured" });
    const { id: projectId } = req.params as { id: string };
    let body: {
      scope?: string;
      prNumber?: number;
      persona?: string;
      username?: string;
      password?: string;
      dataBranchDiffers?: boolean;
    };
    try {
      body = JSON.parse(req.body as string) as typeof body;
    } catch {
      return reply.code(400).send({ error: "invalid JSON" });
    }
    const { scope, persona, username, password } = body;
    if ((scope !== "project" && scope !== "pr") || !persona || !username || !password) {
      return reply.code(400).send({ error: "scope(project|pr), persona, username, password are required" });
    }
    if (scope === "pr" && typeof body.prNumber !== "number") {
      return reply.code(400).send({ error: "prNumber is required for pr-scoped credentials" });
    }
    const usernameSecretId = await config.storeSecret(projectId, "username", username);
    const passwordSecretId = await config.storeSecret(projectId, "password", password);
    const row = await store().createCredentialSet({
      projectId,
      scope,
      prNumber: scope === "pr" ? body.prNumber! : null,
      persona,
      usernameSecretId,
      passwordSecretId,
      dataBranchDiffers: body.dataBranchDiffers ?? scope === "pr",
    });
    return reply.code(201).send({ id: row.id, scope: row.scope, persona: row.persona });
  });

  app.delete("/api/credentials/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const deleted = await store().deleteCredentialSet(id);
    return reply.code(deleted ? 200 : 404).send({ deleted });
  });

  // ── recordings (doc 03: extension upload + DevTools import) ──────────────
  app.post("/api/recordings", async (req, reply) => {
    if (!config.recordings) return reply.code(500).send({ error: "recordings not configured" });
    // token auth is org-level in Phase 13; for now require SOME bearer token
    if (!req.headers.authorization?.startsWith("Bearer ")) {
      return reply.code(401).send({ error: "missing bearer token" });
    }
    const fields: Record<string, string> = {};
    let bundle: Buffer | null = null;
    for await (const part of req.parts()) {
      if (part.type === "file" && part.fieldname === "bundle") {
        bundle = await part.toBuffer();
      } else if (part.type === "field") {
        fields[part.fieldname] = String(part.value);
      }
    }
    if (!bundle || !fields["projectId"]) {
      return reply.code(400).send({ error: "projectId field and bundle file are required" });
    }
    try {
      const result = await handleRecordingUpload(
        { store: config.deps.store, putObject: config.recordings.putObject },
        { projectId: fields["projectId"], flowName: fields["flowName"] ?? null, bundle },
      );
      // doc 03 A2: upload enqueues the compile job
      await config.compiler?.enqueueCompile(result.recordingId);
      return reply.code(201).send(result);
    } catch (err) {
      if (isFlowGuardError(err) && err.code === "validation_failed") {
        return reply.code(422).send({ error: err.message, details: err.details });
      }
      throw err;
    }
  });

  app.post("/api/recordings/import-devtools", async (req, reply) => {
    if (!config.recordings) return reply.code(500).send({ error: "recordings not configured" });
    let body: { projectId?: string; flowName?: string; recording?: DevToolsRecording };
    try {
      body = JSON.parse(req.body as string) as typeof body;
    } catch {
      return reply.code(400).send({ error: "invalid JSON" });
    }
    if (!body.projectId || !body.recording) {
      return reply.code(400).send({ error: "projectId and recording are required" });
    }
    try {
      const result = await handleDevToolsImport(
        { store: config.deps.store, putObject: config.recordings.putObject },
        { projectId: body.projectId, flowName: body.flowName ?? null, recording: body.recording },
      );
      return reply.code(201).send(result);
    } catch (err) {
      if (isFlowGuardError(err) && err.code === "validation_failed") {
        return reply.code(422).send({ error: err.message, details: err.details });
      }
      throw err;
    }
  });

  // ── compiler & drafts (Phase 6) ───────────────────────────────────────────
  app.post("/api/recordings/:id/compile", async (req, reply) => {
    if (!config.compiler) return reply.code(500).send({ error: "compiler not configured" });
    const { id } = req.params as { id: string };
    const rec = await store().getRecording(id);
    if (!rec) return reply.code(404).send({ error: "recording not found" });
    await config.compiler.enqueueCompile(id);
    return reply.code(202).send({ ok: true, recordingId: id });
  });

  app.get("/api/projects/:id/recordings", async (req) => {
    const { id } = req.params as { id: string };
    return store().listRecordings(id);
  });

  app.get("/api/projects/:id/drafts", async (req) => {
    const { id } = req.params as { id: string };
    return store().listDraftVersions(id);
  });

  app.get("/api/projects/:id/flows", async (req) => {
    const { id } = req.params as { id: string };
    return store().listFlows(id);
  });

  // ── base-branch lifecycle (doc 05 §5): manual trigger + alerts ──
  app.post("/api/projects/:id/base-run", async (req, reply) => {
    if (!config.startBaseRun) return reply.code(500).send({ error: "base runs not configured" });
    const { id } = req.params as { id: string };
    let body: { branch?: string };
    try {
      body = JSON.parse((req.body as string) || "{}") as typeof body;
    } catch {
      return reply.code(400).send({ error: "invalid JSON" });
    }
    const runId = await config.startBaseRun(id, body.branch ?? "main");
    if (!runId) return reply.code(409).send({ error: "no READY deployment for that branch" });
    return reply.code(202).send({ ok: true, runId });
  });

  app.get("/api/projects/:id/alerts", async (req) => {
    const { id } = req.params as { id: string };
    return store().listAlerts(id);
  });

  app.post("/api/projects/:id/alerts/ack", async (req, reply) => {
    const { id } = req.params as { id: string };
    let body: { kind?: string; flowId?: string };
    try {
      body = JSON.parse(req.body as string) as typeof body;
    } catch {
      return reply.code(400).send({ error: "invalid JSON" });
    }
    if (!body.kind) return reply.code(400).send({ error: "kind required" });
    await store().acknowledgeAlerts(id, body.kind, body.flowId);
    return { ok: true };
  });

  // ── the 🔵 loop (doc 05 §3.6): approve → pending version; reject → 🔴 ──
  app.get("/api/projects/:id/verdicts", async (req) => {
    const { id } = req.params as { id: string };
    return store().listAwaitingVerdicts(id);
  });

  app.post("/api/verdicts/:id/approve", async (req, reply) => {
    const { id } = req.params as { id: string };
    const verdict = await store().getVerdictById(id);
    if (!verdict) return reply.code(404).send({ error: "verdict not found" });
    if (verdict.approvalState !== "awaiting") {
      return reply.code(409).send({ error: `verdict is ${verdict.approvalState ?? "not approvable"}` });
    }
    const run = await store().getRunById(verdict.runId);
    const pr = run?.prId ? await store().getPullRequestById(run.prId) : null;
    const branch = pr?.baseBranch ?? "main";
    const pendingVersionId = await createPendingVersion({
      store: store(),
      flowId: verdict.flowId,
      runId: verdict.runId,
      branch,
      note: `approved 🔵: ${verdict.humanCopy}`,
    });
    if (!pendingVersionId) return reply.code(409).send({ error: "no official version to supersede" });
    await store().setVerdictApproval(id, { approvalState: "approved", pendingVersionId });
    return { ok: true, pendingVersionId };
  });

  app.post("/api/verdicts/:id/reject", async (req, reply) => {
    const { id } = req.params as { id: string };
    const verdict = await store().getVerdictById(id);
    if (!verdict) return reply.code(404).send({ error: "verdict not found" });
    if (verdict.approvalState !== "awaiting") {
      return reply.code(409).send({ error: `verdict is ${verdict.approvalState ?? "not approvable"}` });
    }
    // doc 05 §3.6: reject converts the 🔵 to 🔴
    await store().setVerdictApproval(id, { approvalState: "rejected", verdict: "broken" });
    return { ok: true };
  });

  // spec drift from successful heals (doc 04 §5): accept → pending version
  app.get("/api/projects/:id/heal-patches", async (req) => {
    const { id } = req.params as { id: string };
    return store().listHealPatches(id);
  });

  app.post("/api/heal-patches/accept", async (req, reply) => {
    let body: { runId?: string; flowId?: string };
    try {
      body = JSON.parse(req.body as string) as typeof body;
    } catch {
      return reply.code(400).send({ error: "invalid JSON" });
    }
    if (!body.runId || !body.flowId) return reply.code(400).send({ error: "runId and flowId required" });
    const run = await store().getRunById(body.runId);
    if (!run) return reply.code(404).send({ error: "run not found" });
    const pr = run.prId ? await store().getPullRequestById(run.prId) : null;
    const pendingVersionId = await createPendingVersion({
      store: store(),
      flowId: body.flowId,
      runId: body.runId,
      branch: pr?.baseBranch ?? "main",
      note: "accepted spec-drift locator patch from adaptive retry",
    });
    if (!pendingVersionId) return reply.code(409).send({ error: "no official version to supersede" });
    return { ok: true, pendingVersionId };
  });

  // smoke-tier toggle (doc 06 §4.2) — smoke flows run on every push regardless of diff
  app.patch("/api/flows/:id/tier", async (req, reply) => {
    const { id } = req.params as { id: string };
    let body: { tier?: string };
    try {
      body = JSON.parse(req.body as string) as typeof body;
    } catch {
      return reply.code(400).send({ error: "invalid JSON" });
    }
    if (body.tier !== "smoke" && body.tier !== "standard") {
      return reply.code(400).send({ error: 'tier must be "smoke" or "standard"' });
    }
    await store().setFlowTier(id, body.tier);
    return { ok: true, flowId: id, tier: body.tier };
  });

  app.get("/api/drafts/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const version = await store().getFlowVersion(id);
    if (!version) return reply.code(404).send({ error: "draft not found" });
    // join step ↔ after-screenshot via the recording trace, for the review screen
    let stepScreenshots: Record<string, string> = {};
    if (version.sourceRecordingId && config.recordings?.getObject) {
      try {
        const rec = await store().getRecording(version.sourceRecordingId);
        if (rec) {
          const { unzipSync, strFromU8 } = await import("fflate");
          const files = unzipSync(await config.recordings.getObject(rec.traceKey));
          const trace = JSON.parse(strFromU8(files["trace.json"]!)) as {
            events: Array<{ id: string; screenshotAfter: string | null; screenshotBefore: string | null }>;
          };
          const report = version.compilationReport as { stepSourceEvents?: Record<string, string[]> } | null;
          for (const [stepId, eventIds] of Object.entries(report?.stepSourceEvents ?? {})) {
            for (const evId of eventIds) {
              const ev = trace.events.find((e) => e.id === evId);
              const shot = ev?.screenshotAfter ?? ev?.screenshotBefore;
              if (shot) {
                stepScreenshots[stepId] = `/api/recordings/${version.sourceRecordingId}/asset?path=${encodeURIComponent(shot)}`;
                break;
              }
            }
          }
        }
      } catch {
        stepScreenshots = {};
      }
    }
    return { ...version, stepScreenshots };
  });

  app.get("/api/recordings/:id/asset", async (req, reply) => {
    if (!config.recordings?.getObject) return reply.code(500).send({ error: "not configured" });
    const { id } = req.params as { id: string };
    const { path } = req.query as { path?: string };
    if (!path || path.includes("..")) return reply.code(400).send({ error: "bad path" });
    const rec = await store().getRecording(id);
    if (!rec) return reply.code(404).send({ error: "recording not found" });
    const { unzipSync } = await import("fflate");
    const files = unzipSync(await config.recordings.getObject(rec.traceKey));
    const file = files[path];
    if (!file) return reply.code(404).send({ error: "no such asset" });
    const type = path.endsWith(".jpg") ? "image/jpeg" : path.endsWith(".png") ? "image/png" : "application/json";
    return reply.header("content-type", type).send(Buffer.from(file));
  });

  app.post("/api/drafts/:id/confirm", async (req, reply) => {
    if (!config.compiler) return reply.code(500).send({ error: "compiler not configured" });
    const { id } = req.params as { id: string };
    const version = await store().getFlowVersion(id);
    if (!version) return reply.code(404).send({ error: "draft not found" });
    if (version.status !== "draft") return reply.code(409).send({ error: `version is ${version.status}, not draft` });
    let body: { spec?: unknown };
    try {
      body = JSON.parse(req.body as string) as typeof body;
    } catch {
      return reply.code(400).send({ error: "invalid JSON" });
    }
    // human-confirmed spec (assertions are ALWAYS human-confirmed, doc 03 B7)
    const { FlowSpecSchema } = await import("@flowguard/schemas");
    const parsed = FlowSpecSchema.safeParse(body.spec ?? version.spec);
    if (!parsed.success) {
      return reply.code(422).send({
        error: "edited spec failed validation",
        issues: parsed.error.issues.slice(0, 5).map((i) => `${i.path.join(".")}: ${i.message}`),
      });
    }
    // spec rows are immutable: the confirmed edit becomes a new draft row
    const confirmedId = await store().insertFlowVersion({
      flowId: version.flowId,
      spec: parsed.data,
      status: "draft",
      branch: version.branch,
      source: "recording",
      sourceRecordingId: version.sourceRecordingId,
      supersedesVersionId: version.id,
      compilationReport: { ...(version.compilationReport ?? {}), confirmedAt: new Date().toISOString() },
    });
    await store().setVersionStatus(version.id, "archived");
    await config.compiler.enqueueValidate(confirmedId);
    return reply.code(202).send({ versionId: confirmedId, validating: true });
  });

  app.post("/api/flows/plain-language", async (req, reply) => {
    if (!config.compiler?.draftFromDescription) {
      return reply.code(500).send({ error: "plain-language authoring not configured" });
    }
    let body: { projectId?: string; name?: string; description?: string };
    try {
      body = JSON.parse(req.body as string) as typeof body;
    } catch {
      return reply.code(400).send({ error: "invalid JSON" });
    }
    if (!body.projectId || !body.description) {
      return reply.code(400).send({ error: "projectId and description are required" });
    }
    const result = await config.compiler.draftFromDescription(
      body.projectId,
      body.name ?? "Described flow",
      body.description,
    );
    return reply.code(201).send(result);
  });

  app.get("/artifacts", async (req, reply) => {
    if (!config.artifacts) return reply.code(404).send({ error: "artifacts not configured" });
    const { key, sig } = req.query as { key?: string; sig?: string };
    if (!key || !sig || !config.artifacts.verifySig(key, sig)) {
      return reply.code(403).send({ error: "invalid artifact signature" });
    }
    const url = await config.artifacts.presign(key);
    return reply.redirect(url, 302);
  });

  app.post("/webhooks/github", async (req, reply) => {
    const rawBody = req.body as string;
    const signature = req.headers["x-hub-signature-256"] as string | undefined;
    if (!verifyWebhookSignature(config.webhookSecret, rawBody, signature)) {
      req.log.warn("webhook signature verification failed");
      return reply.code(401).send({ error: "invalid signature" });
    }

    const event = req.headers["x-github-event"] as string | undefined;
    const deliveryId = req.headers["x-github-delivery"] as string | undefined;
    if (!event || !deliveryId) {
      return reply.code(400).send({ error: "missing event headers" });
    }

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(rawBody) as Record<string, unknown>;
    } catch {
      return reply.code(400).send({ error: "invalid JSON" });
    }

    // idempotency on delivery id (doc 01 §6) — redeliveries are acknowledged, not re-run
    const fresh = await config.deps.store.markDeliveryProcessed(
      deliveryId,
      event,
      payload["action"] as string | undefined,
    );
    if (!fresh) {
      req.log.info({ deliveryId, event }, "duplicate delivery — skipped");
      return reply.code(202).send({ ok: true, duplicate: true });
    }

    // ack fast, process inline (Phase 1 volume); handlers never throw upstream
    try {
      switch (event) {
        case "installation":
          await handleInstallation(config.deps, payload as unknown as InstallationEvent);
          break;
        case "deployment_status":
          await handleDeploymentStatus(config.deps, payload as unknown as DeploymentStatusEvent);
          break;
        case "pull_request":
          await handlePullRequest(config.deps, payload as unknown as PullRequestEvent);
          break;
        case "issue_comment":
          await handleIssueComment(config.deps, payload as unknown as IssueCommentEvent);
          break;
        case "push":
          // fallback trigger path (doc 06 §2) — polling fallback lands with Phase 3
          break;
        default:
          req.log.debug({ event }, "unhandled webhook event");
      }
    } catch (err) {
      // never bounce the webhook: GitHub retries would re-run side effects
      req.log.error({ err, event, deliveryId }, "webhook handler failed");
    }

    return reply.code(202).send({ ok: true });
  });

  return app;
}
