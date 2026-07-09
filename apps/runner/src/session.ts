import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Browser } from "playwright";
import type { Logger } from "pino";
import { and, eq } from "drizzle-orm";
import { createDb } from "@flowguard/db";
import { sessionStates } from "@flowguard/db";
import { NetworkTracker } from "./network-tracker.js";
import { gotoWithRetry, runStepOnce, type SecretLookup } from "./steps.js";
import type { ArtifactStore } from "./artifacts.js";
import type { ExecuteFlowJob } from "./types.js";

/**
 * Log in once per (persona, deployment), cache the storageState in S3, inject it
 * into every subsequent flow context (doc 07 §5). The login context collects NO
 * artifacts — no video, no trace, no HAR — so credentials can never leak into a
 * flow's evidence bundle.
 */
export class LoginFailedError extends Error {
  constructor(readonly detail: string) {
    super(`login failed: ${detail}`);
    this.name = "LoginFailedError";
  }
}

export interface SessionDeps {
  browser: Browser;
  artifacts: ArtifactStore;
  logger: Logger;
  lookupSecret: SecretLookup;
  /** Best-effort session_states row insert; absent in CLI mode. */
  databaseUrl?: string;
}

/** Returns a local storageState file path, or null for unauthenticated flows. */
export async function ensureStorageState(
  deps: SessionDeps,
  job: ExecuteFlowJob,
): Promise<string | null> {
  const persona = job.configBundle.persona;
  if (!persona) return null;
  const workdir = await mkdtemp(path.join(tmpdir(), "flowguard-session-"));
  const statePath = path.join(workdir, "storageState.json");

  // orchestrator bakes the key at planning time; a parallel/earlier job may have
  // logged in since — re-check the cache at execution time so login truly runs
  // ONCE per (persona, deployment), not once per flow (doc 07 §5)
  const cachedKey = persona.storageStateKey ?? (await lookupSessionKey(deps, persona.name, job));
  if (cachedKey) {
    try {
      const data = await deps.artifacts.getBuffer(cachedKey);
      await writeFile(statePath, data);
      deps.logger.info({ persona: persona.name, key: cachedKey }, "storageState cache hit — login skipped");
      return statePath;
    } catch (err) {
      deps.logger.warn({ err, key: cachedKey }, "cached storageState unavailable — logging in fresh");
    }
  }

  if (!persona.loginSpec) {
    throw new LoginFailedError(`persona "${persona.name}" has no Login flow to establish a session with`);
  }

  deps.logger.info(
    { persona: persona.name, deployment: job.target.deploymentId ?? job.target.deploymentUrl },
    "no cached session — executing Login flow once for this target",
  );
  // throwaway context: NO artifacts (video/trace/har) — secrets stay out of evidence
  const context = await deps.browser.newContext({
    viewport: {
      width: persona.loginSpec.viewport.width,
      height: persona.loginSpec.viewport.height,
    },
  });
  try {
    const page = await context.newPage();
    const tracker = new NetworkTracker();
    tracker.attach(page);
    const baseUrl = job.target.deploymentUrl.replace(/\/$/, "");
    if (job.target.bypassSecret) {
      await page.route("**/*", async (route) => {
        const req = route.request();
        if (req.isNavigationRequest() && new URL(req.url()).host === new URL(baseUrl).host) {
          await route.continue({
            headers: {
              ...req.headers(),
              "x-vercel-protection-bypass": job.target.bypassSecret!,
              "x-vercel-set-bypass-cookie": "true",
            },
          });
          return;
        }
        await route.continue();
      });
    }
    await gotoWithRetry(page, baseUrl + persona.loginSpec.startPath, deps.logger);

    const ctx = { page, baseUrl, tracker, logger: deps.logger, lookupSecret: deps.lookupSecret };
    for (const step of persona.loginSpec.steps) {
      let outcome = await runStepOnce(ctx, step);
      if (outcome.failure) outcome = await runStepOnce(ctx, step); // one deterministic retry
      if (outcome.failure) {
        throw new LoginFailedError(`step ${step.id} "${step.title}": ${outcome.failure.message}`);
      }
    }

    await context.storageState({ path: statePath });
    await persistSession(deps, job, statePath);
    return statePath;
  } finally {
    await context.close().catch(() => {});
  }
}

async function lookupSessionKey(
  deps: SessionDeps,
  persona: string,
  job: ExecuteFlowJob,
): Promise<string | null> {
  const deploymentId = job.target.deploymentId;
  if (!deploymentId || (deps.databaseUrl === undefined && !process.env.DATABASE_URL)) return null;
  try {
    const db = createDb(deps.databaseUrl);
    const rows = await db
      .select({ s3Key: sessionStates.s3Key })
      .from(sessionStates)
      .where(and(eq(sessionStates.persona, persona), eq(sessionStates.deploymentId, deploymentId)))
      .limit(1);
    return rows[0]?.s3Key ?? null;
  } catch {
    return null;
  }
}

async function persistSession(deps: SessionDeps, job: ExecuteFlowJob, statePath: string): Promise<void> {
  const persona = job.configBundle.persona!;
  const deploymentId = job.target.deploymentId;
  if (!deploymentId) return; // CLI/ad-hoc runs: no cache row to key
  const key = `ss/${job.spec.projectId}/${persona.name}/${deploymentId}.json`;
  try {
    await deps.artifacts.putFile(key, statePath, "application/json");
    if (deps.databaseUrl !== undefined || process.env.DATABASE_URL) {
      const db = createDb(deps.databaseUrl);
      await db
        .insert(sessionStates)
        .values({ persona: persona.name, deploymentId, s3Key: key })
        .onConflictDoUpdate({
          target: [sessionStates.persona, sessionStates.deploymentId],
          set: { s3Key: key },
        });
    }
    deps.logger.info({ persona: persona.name, key }, "storageState cached for this deployment");
  } catch (err) {
    deps.logger.warn({ err }, "storageState caching failed — flows still run with the fresh session");
  }
}
