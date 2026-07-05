/** Minimal typed views of the GitHub webhook payloads we consume (doc 06 §2). */

export interface RepoRef {
  full_name: string; // "owner/repo"
}

export interface InstallationEvent {
  action: "created" | "deleted" | "suspend" | "unsuspend" | "new_permissions_accepted" | string;
  installation: { id: number; account: { login: string } | null };
}

export interface DeploymentStatusEvent {
  action: "created" | string;
  deployment_status: {
    state: "success" | "failure" | "error" | "pending" | "in_progress" | string;
    target_url?: string | null;
    environment_url?: string | null;
    environment?: string;
  };
  deployment: {
    id: number;
    sha: string;
    /** Vercel sets this to the branch name. */
    ref: string;
    environment: string;
  };
  repository: RepoRef;
  installation?: { id: number };
}

export interface PullRequestEvent {
  action: "opened" | "reopened" | "synchronize" | "closed" | string;
  number: number;
  pull_request: {
    number: number;
    title: string;
    body: string | null;
    state: string;
    merged?: boolean;
    user: { login: string } | null;
    head: { ref: string; sha: string };
    base: { ref: string };
  };
  repository: RepoRef;
  installation?: { id: number };
}

export interface IssueCommentEvent {
  action: "created" | string;
  issue: { number: number; pull_request?: object };
  comment: { id: number; body: string; user: { login: string } | null };
  repository: RepoRef;
  installation?: { id: number };
}
