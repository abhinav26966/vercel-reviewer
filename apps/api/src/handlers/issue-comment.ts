import type { HandlerDeps } from "./deps.js";
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
    // Phase 3 wires this to "re-run latest SHA"; Phase 1 records the intent.
    deps.logger.info(
      { pr: payload.issue.number, by: payload.comment.user?.login },
      "/flowguard rerun received (execution lands in Phase 3)",
    );
  } else {
    deps.logger.info({ raw: command.raw }, "unknown /flowguard command ignored");
  }
  return command;
}
