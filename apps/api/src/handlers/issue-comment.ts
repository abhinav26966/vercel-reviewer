import type { HandlerDeps } from "./deps.js";
import { installationClient, splitRepo } from "./deps.js";
import type { IssueCommentEvent } from "../webhook-types.js";

export type FlowGuardCommand = { kind: "rerun" } | { kind: "unknown"; raw: string };

/** Parse `/flowguard <cmd>` comment commands (doc 06 §2). */
export function parseCommand(body: string): FlowGuardCommand | null {
  const match = body.trim().match(/^\/flowguard\s+(\S+)/i);
  if (!match) return null;
  const cmd = match[1]!.toLowerCase();
  if (cmd === "rerun") return { kind: "rerun" };
  return { kind: "unknown", raw: cmd };
}

export async function handleIssueComment(
  deps: HandlerDeps,
  payload: IssueCommentEvent,
): Promise<FlowGuardCommand | null> {
  if (payload.action !== "created" || !payload.issue.pull_request) return null;
  const command = parseCommand(payload.comment.body);
  if (!command) return null;

  const project = await deps.store.getProjectByRepo(payload.repository.full_name);
  if (!project) return null;

  if (command.kind === "rerun") {
    // re-run the latest SHA (doc 06 §2): reuse the existing run row if present
    const prRow = await deps.store.upsertPullRequest({
      projectId: project.id,
      number: payload.issue.number,
      baseBranch: "main", // refreshed below from the API if available
      state: "open",
    });
    const octokit = await installationClient(deps, payload.installation?.id ?? project.installationId);
    if (!octokit) return command;
    const { owner, repo } = splitRepo(payload.repository.full_name);
    const { data: pr } = await octokit.rest.pulls.get({
      owner,
      repo,
      pull_number: payload.issue.number,
    });
    await deps.store.upsertPullRequest({
      projectId: project.id,
      number: pr.number,
      title: pr.title,
      baseBranch: pr.base.ref,
      state: pr.state,
    });
    const deployment = await deps.store.getLatestDeploymentForSha(project.id, pr.head.sha);
    if (!deployment) {
      deps.logger.warn({ pr: pr.number }, "/flowguard rerun: no deployment known for head sha");
      return command;
    }
    // reuse the existing run for (sha, deployment) via createRun's idempotency; a
    // rerun resets it to planning and the orchestrator overwrites its results
    const { run } = await deps.store.createRun({
      projectId: project.id,
      kind: "pr",
      state: "planning",
      prId: prRow.id,
      headSha: pr.head.sha,
      headDeploymentId: deployment.id,
    });
    await deps.store.updateRun(run.id, { state: "planning" });
    if (deps.enqueueOrchestration) await deps.enqueueOrchestration(run.id);
    deps.logger.info({ pr: pr.number, run: run.id }, "/flowguard rerun — re-orchestrating");
  } else {
    deps.logger.info({ raw: command.raw }, "unknown /flowguard command ignored");
  }
  return command;
}
