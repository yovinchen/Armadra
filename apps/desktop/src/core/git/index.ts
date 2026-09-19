import type { CoreContext } from "../main";
import { affectsRepositories, invalidate } from "./discovery";
import { RepositoryService } from "./repository/service";
import { installRoutes } from "./routes";

/**
 * The Git domain.
 *
 * One {@link RepositoryService} for the whole core, because the queue it holds
 * is what makes writes to one repository serial and writes to two repositories
 * parallel — a second instance would be a second queue for the same worktree.
 *
 * The domain publishes no event of its own. `apps/runtime/src/events.rs` has
 * none for Git: the panel polls its operations, and the one thing a Git write
 * changes that another domain cares about is the *set* of repositories, which
 * is a discovery cache this module drops when a `file.changed` frame names a
 * `.git` entry.
 */

export function install(context: CoreContext): void {
  const service = new RepositoryService();
  installRoutes({
    server: context.server,
    database: context.db.database,
    service,
    // Which workspace started which operation. It stays on this side rather
    // than in the service because it is a controller concept: the queue only
    // knows repositories, and two workspaces can be rooted in one.
    owners: new Map<string, string>(),
  });

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
