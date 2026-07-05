import { FlowGuardError } from "@flowguard/shared";

/**
 * Minimal Vercel REST client (doc 06 §1 "v1 pragmatic": user-pasted access token).
 * Only the endpoints the orchestrator needs; fetch-based, injectable for tests.
 */

export interface VercelDeployment {
  uid: string;
  url: string;
  name: string;
  state: string; // BUILDING | ERROR | INITIALIZING | QUEUED | READY | CANCELED
  target: string | null; // production | staging | null (preview)
  projectId: string;
  meta?: Record<string, string>;
  createdAt: number;
}

interface ListDeploymentsResponse {
  deployments: Array<{
    uid: string;
    url: string;
    name: string;
    state?: string;
    readyState?: string;
    target?: string | null;
    projectId?: string;
    meta?: Record<string, string>;
    createdAt: number;
  }>;
}

export interface VercelClientOptions {
  token: string;
  teamId?: string | null;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
  baseUrl?: string;
}

export class VercelClient {
  private readonly token: string;
  private readonly teamId: string | null;
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;

  constructor(opts: VercelClientOptions) {
    this.token = opts.token;
    this.teamId = opts.teamId ?? null;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.baseUrl = opts.baseUrl ?? "https://api.vercel.com";
  }

  private async request<T>(path: string, params: Record<string, string> = {}): Promise<T> {
    const url = new URL(path, this.baseUrl);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    if (this.teamId) url.searchParams.set("teamId", this.teamId);
    const res = await this.fetchImpl(url, {
      headers: { Authorization: `Bearer ${this.token}` },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new FlowGuardError("env_issue", `Vercel API ${res.status} for ${path}`, {
        details: { status: res.status, body: body.slice(0, 500) },
      });
    }
    return (await res.json()) as T;
  }

  /** Get a deployment by id (`dpl_…`) or URL (host without protocol). */
  async getDeployment(idOrUrl: string): Promise<VercelDeployment> {
    const cleaned = idOrUrl.replace(/^https?:\/\//, "");
    const d = await this.request<
      VercelDeployment & { readyState?: string; id?: string; uid?: string }
    >(`/v13/deployments/${encodeURIComponent(cleaned)}`);
    return {
      uid: d.uid ?? d.id ?? cleaned,
      url: d.url,
      name: d.name,
      state: d.readyState ?? d.state,
      target: d.target ?? null,
      projectId: d.projectId,
      meta: d.meta,
      createdAt: d.createdAt,
    };
  }

  /** List deployments for a project, optionally filtered by commit SHA. */
  async listDeployments(opts: {
    projectId: string;
    sha?: string;
    target?: "production" | "preview";
    limit?: number;
  }): Promise<VercelDeployment[]> {
    const params: Record<string, string> = {
      projectId: opts.projectId,
      limit: String(opts.limit ?? 20),
    };
    if (opts.sha) params["sha"] = opts.sha;
    if (opts.target) params["target"] = opts.target;
    const res = await this.request<ListDeploymentsResponse>("/v6/deployments", params);
    return res.deployments.map((d) => ({
      uid: d.uid,
      url: d.url,
      name: d.name,
      state: d.readyState ?? d.state ?? "UNKNOWN",
      target: d.target ?? null,
      projectId: d.projectId ?? opts.projectId,
      meta: d.meta,
      createdAt: d.createdAt,
    }));
  }

  /** Does this deployment URL belong to the given Vercel project? (doc 06 §2 filter) */
  async deploymentBelongsToProject(deploymentUrl: string, projectId: string): Promise<boolean> {
    try {
      const d = await this.getDeployment(deploymentUrl);
      return d.projectId === projectId;
    } catch {
      return false;
    }
  }
}
