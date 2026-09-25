import type { CoreContext } from "../main";
import { affectsRepositories, invalidate } from "./discovery";
import { RepositoryService } from "./repository/service";
import { isTerminal } from "./repository/types";
import { installRoutes } from "./routes";

/**
 * The Git domain.
 *
 * One {@link RepositoryService} for the whole core, because the queue it holds
 * is what makes writes to one repository serial and writes to two repositories
 * parallel — a second instance would be a second queue for the same worktree.
 *
 * The domain publishes no event of its own. the pre-merge implementation has
 * none for Git: the panel polls its operations, and the one thing a Git write
 * changes that another domain cares about is the *set* of repositories, which
 * is a discovery cache this module drops when a `file.changed` frame names a
 * `.git` entry.
 */

/**
 * The Git operations a workspace started that have not finished — what a
 * switch of execution host has to wait for, because moving underneath a
 * rebase in flight would strand it on the machine being left.
 *
 * Module-level for the same reason `settingsDomain()` is: the workspace
 * domain asks, and threading the Git domain through `CoreContext` for one
 * question would put it in every signature. Empty until `install` runs.
 */
let active: (workspaceId: string) => string[] = () => [];

export function activeOperations(workspaceId: string): string[] {
  return active(workspaceId);
}

export function install(context: CoreContext): void {
  const service = new RepositoryService();
  // Which workspace started which operation. It stays on this side rather
  // than in the service because it is a controller concept: the queue only
  // knows repositories, and two workspaces can be rooted in one.
  const owners = new Map<string, string>();
  installRoutes({
    server: context.server,
    database: context.db.database,
    service,
    owners,
  });
  active = (workspaceId) =>
    [...owners]
      .filter(([id, owner]) => {
        if (owner !== workspaceId) return false;
        const operation = service.entry(id);
        return operation !== undefined && !isTerminal(operation.snapshot.state);
      })
      .map(([id]) => id);

  // The repository scan is cached, and a worktree appearing is not otherwise
  // observed — `file.changed` only covers files an editor has open — so the
  // cache is dropped here and the next list rescans.
  context.bus.on("workspace.event", ({ workspaceId, event }) => {
    if (event.type !== "file.changed") return;
    if (affectsRepositories(event.path)) invalidate(workspaceId);
  });
}

export { gitFingerprint, UNAVAILABLE } from "./fingerprint";
export type { GitFingerprint } from "./fingerprint";
