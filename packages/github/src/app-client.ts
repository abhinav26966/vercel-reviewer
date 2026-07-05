import { App } from "octokit";
import type { Octokit } from "octokit";

export interface GithubAppConfig {
  appId: string | number;
  /** PEM private key (decoded, with real newlines). */
  privateKey: string;
}

export type InstallationClient = Octokit;

export interface GithubAppClient {
  getInstallationOctokit(installationId: number): Promise<InstallationClient>;
}

/** Octokit App wrapper — installation-token minting per org (doc 06 §1). */
export function createGithubApp(config: GithubAppConfig): GithubAppClient {
  const app = new App({ appId: config.appId, privateKey: config.privateKey });
  return {
    async getInstallationOctokit(installationId: number) {
      return (await app.getInstallationOctokit(installationId)) as unknown as Octokit;
    },
  };
}

export function decodePrivateKey(base64OrPem: string): string {
  if (base64OrPem.includes("-----BEGIN")) return base64OrPem;
  return Buffer.from(base64OrPem, "base64").toString("utf8");
}
