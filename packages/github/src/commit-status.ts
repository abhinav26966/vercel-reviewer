export const STATUS_CONTEXT = "flowguard/flows";

/** Narrow slice of octokit.rest.repos — injectable for tests. */
export interface ReposApi {
  createCommitStatus(params: {
    owner: string;
    repo: string;
    sha: string;
    state: "error" | "failure" | "pending" | "success";
    description?: string;
    context?: string;
    target_url?: string;
  }): Promise<unknown>;
}

export async function setCommitStatus(
  api: ReposApi,
  params: {
    owner: string;
    repo: string;
    sha: string;
    state: "error" | "failure" | "pending" | "success";
    description: string;
    targetUrl?: string;
  },
): Promise<void> {
  await api.createCommitStatus({
    owner: params.owner,
    repo: params.repo,
    sha: params.sha,
    state: params.state,
    // GitHub caps description at 140 chars
    description: params.description.slice(0, 140),
    context: STATUS_CONTEXT,
    ...(params.targetUrl ? { target_url: params.targetUrl } : {}),
  });
}
