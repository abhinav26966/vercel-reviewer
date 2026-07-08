import Fastify from "fastify";
import type { Logger } from "pino";
import { verifyWebhookSignature } from "@flowguard/github";
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
  };
}

export type ApiApp = ReturnType<typeof buildApp>;

export function buildApp(config: AppConfig) {
  const app = Fastify({ loggerInstance: config.logger });

  // keep the raw body: signatures verify over bytes, not parsed JSON
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
    done(null, body);
  });

  app.get("/healthz", async () => ({ ok: true }));

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
