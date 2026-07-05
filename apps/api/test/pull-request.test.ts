import { describe, expect, it } from "vitest";
import { handlePullRequest } from "../src/handlers/pull-request.js";
import { parseCommand } from "../src/handlers/issue-comment.js";
import type { PullRequestEvent } from "../src/webhook-types.js";
import { FakeStore, boundProject, fakeOctokit, makeDeps } from "./fakes.js";

function prEvent(action: string, overrides: Partial<PullRequestEvent["pull_request"]> = {}): PullRequestEvent {
  return {
    action,
    number: 7,
    pull_request: {
      number: 7,
      title: "Add feature",
      body: "desc",
      state: action === "closed" ? "closed" : "open",
      user: { login: "author" },
      head: { ref: "feat", sha: "headsha" },
      base: { ref: "main" },
      ...overrides,
    },
    repository: { full_name: "founder/flowguard" },
    installation: { id: 555 },
  };
}

describe("handlePullRequest", () => {
  it("pre-creates an awaiting_deployment run and a pending status on open", async () => {
    const store = new FakeStore();
    store.projects.push({ ...boundProject });
    const { octokit, statuses } = fakeOctokit();

    await handlePullRequest(makeDeps(store, octokit), prEvent("opened"));

    expect(store.runs).toHaveLength(1);
    expect(store.runs[0]).toMatchObject({ kind: "pr", state: "awaiting_deployment", headSha: "headsha" });
    expect(statuses).toEqual([
      { sha: "headsha", state: "pending", description: "waiting for preview build" },
    ]);
  });

  it("does not duplicate the run when synchronize repeats the same sha", async () => {
    const store = new FakeStore();
    store.projects.push({ ...boundProject });
    const { octokit } = fakeOctokit();
    const deps = makeDeps(store, octokit);

    await handlePullRequest(deps, prEvent("opened"));
    await handlePullRequest(deps, prEvent("synchronize"));
    expect(store.runs).toHaveLength(1);
  });

  it("cancels open runs when the PR closes", async () => {
    const store = new FakeStore();
    store.projects.push({ ...boundProject });
    const { octokit } = fakeOctokit();
    const deps = makeDeps(store, octokit);

    await handlePullRequest(deps, prEvent("opened"));
    await handlePullRequest(deps, prEvent("closed", { merged: false }));

    expect(store.runs[0]!.state).toBe("cancelled");
    expect(store.pullRequests[0]!.state).toBe("closed");
  });

  it("marks merged PRs as merged", async () => {
    const store = new FakeStore();
    store.projects.push({ ...boundProject });
    const { octokit } = fakeOctokit();
    const deps = makeDeps(store, octokit);

    await handlePullRequest(deps, prEvent("opened"));
    await handlePullRequest(deps, prEvent("closed", { merged: true }));
    expect(store.pullRequests[0]!.state).toBe("merged");
  });
});

describe("parseCommand", () => {
  it("parses /flowguard rerun", () => {
    expect(parseCommand("/flowguard rerun")).toEqual({ kind: "rerun" });
    expect(parseCommand("  /FlowGuard RERUN  ")).toEqual({ kind: "rerun" });
  });
  it("flags unknown subcommands", () => {
    expect(parseCommand("/flowguard dance")).toEqual({ kind: "unknown", raw: "dance" });
  });
  it("ignores non-commands", () => {
    expect(parseCommand("LGTM")).toBeNull();
    expect(parseCommand("see /flowguard rerun docs")).toBeNull();
  });
});
