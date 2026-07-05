import type { HandlerDeps } from "./deps.js";
import type { InstallationEvent } from "../webhook-types.js";

export async function handleInstallation(deps: HandlerDeps, payload: InstallationEvent) {
  const { action, installation } = payload;
  const login = installation.account?.login ?? "unknown";
  if (action === "created" || action === "unsuspend" || action === "new_permissions_accepted") {
    await deps.store.upsertInstallation(installation.id, login);
    deps.logger.info({ installationId: installation.id, login }, "installation registered");
  } else if (action === "deleted") {
    await deps.store.removeInstallation(installation.id);
    deps.logger.info({ installationId: installation.id, login }, "installation removed");
  }
}
