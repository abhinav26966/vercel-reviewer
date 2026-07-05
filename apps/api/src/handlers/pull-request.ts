import { setCommitStatus } from "@flowguard/github";
import type { HandlerDeps } from "./deps.js";
import { installationClient, splitRepo } from "./deps.js";
import type { PullRequestEvent } from "../webhook-types.js";

/**
 * pull_request events (doc 06 §2): opened/reopened/synchronize pre-create the run
 * in `awaiting_deployment` (check UI shows "waiting for preview build");
 * closed cancels open runs (PR-scoped credential purge lands in Phase 4).
 */
export async function handlePullRequest(deps: HandlerDeps, payload: PullRequestEvent) {
  const { store, logger } = deps;
  const repoFullName = payload.repository.full_name;
  const project = await store.getProjectByRepo(repoFullName);
  if (!project) return;

  const pr = payload.pull_request;

  if (["opened", "reopened", "synchronize"].includes(payload.action)) {
    const prRow = await store.upsertPullRequest({
      projectId: project.id,
      number: pr.number,
      title: pr.title,
      body: pr.body,
      author: pr.user?.login ?? null,
      headBranch: pr.head.ref,
      baseBranch: pr.base.ref,
      state: "open",
    });
    const { run, created } = await store.createRun({
      projectId: project.id,
      kind: "pr",
      state: "awaiting_deployment",
      prId: prRow.id,
      headSha: pr.head.sha,
    });
    logger.info({ pr: pr.number, run: run.id, created }, "PR run awaiting deployment");

    const octokit = await installationClient(deps, payload.installation?.id ?? project.installationId);
    if (octokit) {
      const { owner, repo } = splitRepo(repoFullName);
      await setCommitStatus(octokit.rest.repos, {
        owner,
        repo,
        sha: pr.head.sha,
        state: "pending",
        description: "waiting for preview build",
      });
    }
    return;
  }

  if (payload.action === "closed") {
    const prRow = await store.upsertPullRequest({
      projectId: project.id,
      number: pr.number,
      baseBranch: pr.base.ref,
      state: pr.merged ? "merged" : "closed",
    });
    const cancelled = await store.cancelOpenRunsForPr(prRow.id);
    logger.info({ pr: pr.number, cancelled }, "PR closed — open runs cancelled");
    // Phase 4: also expire PR-scoped credentials/payment configs here (doc 07 §3)
  }
}
