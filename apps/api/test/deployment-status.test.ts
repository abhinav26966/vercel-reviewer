import { describe, expect, it } from "vitest";
import { STICKY_MARKER } from "@flowguard/github";
import { handleDeploymentStatus } from "../src/handlers/deployment-status.js";
import { handlePullRequest } from "../src/handlers/pull-request.js";
import type { DeploymentStatusEvent, PullRequestEvent } from "../src/webhook-types.js";
import { FakeStore, boundProject, fakeOctokit, makeDeps } from "./fakes.js";

function deploymentEvent(overrides: Partial<DeploymentStatusEvent["deployment"]> = {}, state = "success"): DeploymentStatusEvent {
  return {
    action: "created",
    deployment_status: {
      state,
      target_url: "https://demo-git-feat-x.vercel.app",
      environment: "Preview",
    },
    deployment: { id: 1, sha: "headsha", ref: "feat", environment: "Preview", ...overrides },
    repository: { full_name: "founder/flowguard" },
    installation: { id: 555 },
  };
}

describe("handleDeploymentStatus", () => {
  it("creates a PR run, ONE sticky comment with the preview URL, and a commit status", async () => {
    const store = new FakeStore();
    store.projects.push({ ...boundProject });
    const { octokit, comments, statuses } = fakeOctokit({ openPrs: [{ number: 7, state: "open" }] });

    await handleDeploymentStatus(makeDeps(store, octokit), deploymentEvent());

    expect(store.runs).toHaveLength(1);
    expect(store.runs[0]).toMatchObject({ kind: "pr", state: "planning", headSha: "headsha" });
    expect(comments).toHaveLength(1);
    expect(comments[0]!.body).toContain(STICKY_MARKER);
    expect(comments[0]!.body).toContain("demo-git-feat-x.vercel.app");
    expect(statuses).toEqual([
      { sha: "headsha", state: "success", description: "preview detected — no flows configured yet" },
    ]);
    expect(store.pullRequests[0]!.stickyCommentId).toBe(comments[0]!.id);
  });

  it("edits the SAME comment on a second deployment — never a second comment", async () => {
    const store = new FakeStore();
    store.projects.push({ ...boundProject });
    const { octokit, comments } = fakeOctokit({ openPrs: [{ number: 7, state: "open" }] });
    const deps = makeDeps(store, octokit);

    await handleDeploymentStatus(deps, deploymentEvent());
    await handleDeploymentStatus(deps, deploymentEvent({ sha: "headsha2" }));

    expect(comments).toHaveLength(1);
    expect(store.runs).toHaveLength(2); // one run per sha, one comment total
  });

  it("upgrades the awaiting_deployment run instead of creating a duplicate", async () => {
    const store = new FakeStore();
    store.projects.push({ ...boundProject });
    const { octokit } = fakeOctokit({ openPrs: [{ number: 7, state: "open" }] });
    const deps = makeDeps(store, octokit);

    const prEvent: PullRequestEvent = {
      action: "opened",
      number: 7,
      pull_request: {
        number: 7,
        title: "PR 7",
        body: null,
        state: "open",
        user: { login: "author" },
        head: { ref: "feat", sha: "headsha" },
        base: { ref: "main" },
      },
      repository: { full_name: "founder/flowguard" },
      installation: { id: 555 },
    };
    await handlePullRequest(deps, prEvent);
    expect(store.runs).toHaveLength(1);
    expect(store.runs[0]!.state).toBe("awaiting_deployment");

    await handleDeploymentStatus(deps, deploymentEvent());
    expect(store.runs).toHaveLength(1);
    expect(store.runs[0]!.state).toBe("planning");
    expect(store.runs[0]!.headDeploymentId).not.toBeNull();
  });

  it("is idempotent for a redelivered/duplicate deployment", async () => {
    const store = new FakeStore();
    store.projects.push({ ...boundProject });
    const { octokit, comments } = fakeOctokit({ openPrs: [{ number: 7, state: "open" }] });
    const deps = makeDeps(store, octokit);

    await handleDeploymentStatus(deps, deploymentEvent());
    await handleDeploymentStatus(deps, deploymentEvent());

    expect(store.runs).toHaveLength(1);
    expect(comments).toHaveLength(1);
  });

  it("creates a base run when the SHA is on a base branch (Vercel sends ref=SHA)", async () => {
    const store = new FakeStore();
    store.projects.push({ ...boundProject });
    // Vercel reality: deployment.ref is the commit SHA, not a branch name
    const { octokit, comments } = fakeOctokit({
      openPrs: [],
      branchContains: { main: ["mergesha"] },
    });

    await handleDeploymentStatus(
      makeDeps(store, octokit),
      deploymentEvent({ ref: "mergesha", sha: "mergesha", environment: "Production" }),
    );

    expect(store.runs).toHaveLength(1);
    expect(store.runs[0]).toMatchObject({ kind: "base", branch: "main", headSha: "mergesha" });
    expect(comments).toHaveLength(0);
  });

  it("still accepts providers that DO send a branch name as ref", async () => {
    const store = new FakeStore();
    store.projects.push({ ...boundProject });
    const { octokit } = fakeOctokit({ openPrs: [] });

    await handleDeploymentStatus(
      makeDeps(store, octokit),
      deploymentEvent({ ref: "main", sha: "mergesha" }),
    );
    expect(store.runs[0]).toMatchObject({ kind: "base", branch: "main" });
  });

  it("ignores non-success states, unbound repos, and SHAs on no base branch", async () => {
    const store = new FakeStore();
    store.projects.push({ ...boundProject });
    const { octokit } = fakeOctokit({ openPrs: [], branchContains: { main: ["othersha"] } });
    const deps = makeDeps(store, octokit);

    await handleDeploymentStatus(deps, deploymentEvent({}, "pending"));
    await handleDeploymentStatus(deps, {
      ...deploymentEvent(),
      repository: { full_name: "other/repo" },
    });
    await handleDeploymentStatus(deps, deploymentEvent({ ref: "featsha", sha: "featsha" }));

    expect(store.runs).toHaveLength(0);
  });

  it("ignores deployments belonging to a different Vercel project (multi-project repo)", async () => {
    const store = new FakeStore();
    store.projects.push({ ...boundProject, vercelTokenRef: "sec_tok" });
    const { octokit, comments } = fakeOctokit({ openPrs: [{ number: 7, state: "open" }] });
    const deps = makeDeps(store, octokit, {
      verifyDeploymentProject: async () => false,
    });

    await handleDeploymentStatus(deps, deploymentEvent());

    expect(store.runs).toHaveLength(0);
    expect(comments).toHaveLength(0);
  });
});
