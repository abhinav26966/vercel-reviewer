import {
  renderPreviewDetectedComment,
  setCommitStatus,
  upsertStickyComment,
} from "@flowguard/github";
import type { HandlerDeps } from "./deps.js";
import { installationClient, splitRepo } from "./deps.js";
import type { DeploymentStatusEvent } from "../webhook-types.js";

/**
 * Primary trigger (doc 06 §2): `deployment_status` with state=success — the built
 * preview, never the raw push. PR runs for open PRs of the head SHA; base-branch
 * deployments start the base-run pipeline (Phase 1: row only).
 */
export async function handleDeploymentStatus(deps: HandlerDeps, payload: DeploymentStatusEvent) {
  const { store, logger } = deps;
  if (payload.deployment_status.state !== "success") return;

  const repoFullName = payload.repository.full_name;
  const project = await store.getProjectByRepo(repoFullName);
  if (!project) {
    logger.debug({ repo: repoFullName }, "deployment for unbound repo — ignored");
    return;
  }

  const url =
    payload.deployment_status.environment_url ?? payload.deployment_status.target_url ?? null;
  if (!url) {
    logger.warn({ repo: repoFullName }, "deployment_status success without a URL — ignored");
    return;
  }
  const sha = payload.deployment.sha;
  const branch = payload.deployment.ref || null;
  const environment =
    payload.deployment_status.environment ?? payload.deployment.environment ?? "unknown";

  // Multi-project repos must not cross-trigger (doc 06 §2): verify the deployment
  // belongs to the bound Vercel project when we have a token to check with.
  if (project.vercelProjectId && project.vercelTokenRef && deps.verifyDeploymentProject) {
    const ok = await deps.verifyDeploymentProject({
      deploymentUrl: url,
      vercelProjectId: project.vercelProjectId,
      vercelTeamId: project.vercelTeamId,
      vercelTokenRef: project.vercelTokenRef,
    });
    if (!ok) {
      logger.info({ url, vercelProjectId: project.vercelProjectId }, "deployment belongs to another Vercel project — ignored");
      return;
    }
  }

  const deployment = await store.upsertDeployment({
    projectId: project.id,
    sha,
    url,
    environment,
    state: "ready",
    branch,
  });

  const installationId = payload.installation?.id ?? project.installationId;
  const octokit = await installationClient(deps, installationId);
  if (!octokit) {
    logger.error({ repo: repoFullName }, "no GitHub installation for project — cannot proceed");
    return;
  }
  const { owner, repo } = splitRepo(repoFullName);

  // Map SHA → open PR(s) (doc 06 §2)
  const { data: prs } = await octokit.rest.repos.listPullRequestsAssociatedWithCommit({
    owner,
    repo,
    commit_sha: sha,
  });
  const openPrs = prs.filter((pr) => pr.state === "open");

  if (openPrs.length > 0) {
    for (const pr of openPrs) {
      const prRow = await store.upsertPullRequest({
        projectId: project.id,
        number: pr.number,
        title: pr.title,
        body: pr.body ?? null,
        author: pr.user?.login ?? null,
        headBranch: pr.head?.ref ?? null,
        baseBranch: pr.base?.ref ?? "main",
        state: "open",
      });

      // upgrade the awaiting_deployment run pre-created by the pull_request event,
      // else create fresh — idempotent on (project, sha, deployment, kind)
      const upgraded = await store.upgradeAwaitingRun({
        projectId: project.id,
        prId: prRow.id,
        headSha: sha,
        headDeploymentId: deployment.id,
      });
      const run =
        upgraded ??
        (
          await store.createRun({
            projectId: project.id,
            kind: "pr",
            state: "planning",
            prId: prRow.id,
            headSha: sha,
            headDeploymentId: deployment.id,
          })
        ).run;

      const body = renderPreviewDetectedComment({ previewUrl: url, sha });
      const { commentId, created } = await upsertStickyComment(
        octokit.rest.issues,
        { owner, repo, prNumber: pr.number },
        body,
        prRow.stickyCommentId,
      );
      if (created || commentId !== prRow.stickyCommentId) {
        await store.setStickyCommentId(prRow.id, commentId);
      }

      await setCommitStatus(octokit.rest.repos, {
        owner,
        repo,
        sha,
        state: "success",
        description: "preview detected — no flows configured yet",
      });

      logger.info(
        { pr: pr.number, run: run.id, url, commentId },
        "PR run created for preview deployment",
      );
    }
    return;
  }

  // No open PR → base-branch pipeline when the ref is a configured base branch
  if (branch && project.baseBranches.includes(branch)) {
    const { run, created } = await store.createRun({
      projectId: project.id,
      kind: "base",
      state: "planning",
      headSha: sha,
      headDeploymentId: deployment.id,
      branch,
    });
    logger.info({ run: run.id, branch, sha, created }, "base run created (no-op body in Phase 1)");
    return;
  }

  logger.debug({ sha, branch, environment }, "deployment matches no open PR or base branch — ignored");
}
