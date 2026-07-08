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
    const { run } = await deps.store.createRun({
      projectId: project.id,
      kind: "pr",
      state: "planning",
      prId: prRow.id,
      headSha: pr.head.sha,
      headDeploymentId: null,
    });
    // a rerun of an already-reported run: reset to planning so the orchestrator re-enters
    await deps.store.updateRun(run.id, { state: "planning" });
    // attach the newest known deployment for this sha, if any
    const deployment = await deps.store.getLatestDeploymentForSha(project.id, pr.head.sha);
    if (!deployment) {
      deps.logger.warn({ pr: pr.number }, "/flowguard rerun: no deployment known for head sha");
      return command;
    }
    await deps.store.updateRun(run.id, { headDeploymentId: deployment.id });
    if (deps.enqueueOrchestration) await deps.enqueueOrchestration(run.id);
    deps.logger.info({ pr: pr.number, run: run.id }, "/flowguard rerun — re-orchestrating");
  } else {
    deps.logger.info({ raw: command.raw }, "unknown /flowguard command ignored");
  }
  return command;
}
