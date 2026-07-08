import { setCommitStatus } from "@flowguard/github";
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
      const { run, fresh } = upgraded
        ? { run: upgraded, fresh: true }
        : await store
            .createRun({
              projectId: project.id,
              kind: "pr",
              state: "planning",
              prId: prRow.id,
              headSha: sha,
              headDeploymentId: deployment.id,
            })
            .then((r) => ({ run: r.run, fresh: r.created }));

      await setCommitStatus(octokit.rest.repos, {
        owner,
        repo,
        sha,
        state: "pending",
        description: "preview detected — flows queued",
      });

      // the orchestrator owns the sticky comment from here (doc 06 §3)
      if (fresh && deps.enqueueOrchestration) {
        await deps.enqueueOrchestration(run.id);
      } else if (!fresh) {
        logger.info({ run: run.id }, "duplicate deployment event for an existing run — not re-orchestrating");
      }

      logger.info({ pr: pr.number, run: run.id, url }, "PR run queued for orchestration");
    }
    return;
  }

  // No open PR → base-branch pipeline when the SHA is on a configured base branch.
  // NOTE: Vercel sets deployment.ref to the COMMIT SHA, not the branch name, so we
  // resolve the branch via the GitHub compare API (doc 06 §2).
  const baseBranch = await resolveBaseBranch(octokit, owner, repo, project.baseBranches, sha, branch);
  if (baseBranch) {
    const { run, created } = await store.createRun({
      projectId: project.id,
      kind: "base",
      state: "planning",
      headSha: sha,
      headDeploymentId: deployment.id,
      branch: baseBranch,
    });
    logger.info(
      { run: run.id, branch: baseBranch, sha, created },
      "base run created (no-op body in Phase 1)",
    );
    return;
  }

  logger.info({ sha, ref: branch, environment }, "deployment matches no open PR or base branch — ignored");
}

/**
 * Is this SHA on one of the configured base branches? `ref` short-circuits when a
 * provider does send a branch name; otherwise compare per branch: status
 * identical/behind ⇒ the commit is contained in the branch.
 */
async function resolveBaseBranch(
  octokit: { rest: { repos: { compareCommitsWithBasehead(params: { owner: string; repo: string; basehead: string }): Promise<{ data: { status: string } }> } } },
  owner: string,
  repo: string,
  baseBranches: string[],
  sha: string,
  ref: string | null,
): Promise<string | null> {
  if (ref && baseBranches.includes(ref)) return ref;
  for (const branch of baseBranches) {
    try {
      const { data } = await octokit.rest.repos.compareCommitsWithBasehead({
        owner,
        repo,
        basehead: `${branch}...${sha}`,
      });
      // identical: sha IS the branch head; behind: sha is an ancestor of the head
      if (data.status === "identical" || data.status === "behind") return branch;
    } catch {
      // unknown sha/branch — keep checking the rest
    }
  }
  return null;
}
