import type { Logger } from "pino";
import type { GithubAppClient, InstallationClient } from "@flowguard/github";
import type { Store } from "../store.js";

/** Verifies a deployment URL belongs to the bound Vercel project (doc 06 §2 filter). */
export type DeploymentProjectVerifier = (params: {
  deploymentUrl: string;
  vercelProjectId: string;
  vercelTeamId: string | null;
  vercelTokenRef: string;
}) => Promise<boolean>;

export interface HandlerDeps {
  store: Store;
  githubApp: GithubAppClient;
  logger: Logger;
  /**
   * Optional: when the project has a Vercel token bound, cross-check that the
   * deployment belongs to the bound Vercel project (multi-project repos must
   * not cross-trigger). Absent (pre-seed) → repo match alone is accepted.
   */
  verifyDeploymentProject?: DeploymentProjectVerifier;
  /** Hand a planning run to the orchestrator (Phase 3). Absent in Phase-1-style tests. */
  enqueueOrchestration?: (runId: string) => Promise<void>;
}

export function splitRepo(fullName: string): { owner: string; repo: string } {
  const [owner, repo] = fullName.split("/");
  if (!owner || !repo) throw new Error(`malformed repo full_name: ${fullName}`);
  return { owner, repo };
}

export async function installationClient(
  deps: HandlerDeps,
  installationId: number | null | undefined,
): Promise<InstallationClient | null> {
  if (!installationId) return null;
  return deps.githubApp.getInstallationOctokit(installationId);
}
