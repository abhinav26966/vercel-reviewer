import Fastify from "fastify";
import multipart from "@fastify/multipart";
import type { Logger } from "pino";
import { verifyWebhookSignature } from "@flowguard/github";
import { isFlowGuardError } from "@flowguard/shared";
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
  recordings?: Pick<RecordingDeps, "putObject">;
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
    reply.header("access-control-allow-methods", "GET,POST,DELETE,OPTIONS");
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
