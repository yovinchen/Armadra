/**
 * Does this workspace exist?
 *
 * The event stream's only question about another domain's data, asked before
 * the upgrade because that is where `apps/runtime/src/api/events.rs` asks it:
 * `db::get_workspace(&state.pool, &workspace_id).await?` runs first, and a
 * missing workspace becomes a `NotFound` — an HTTP 404 with the usual
 * `{ code, message }` body — rather than a socket that opens and then closes.
 *
 * The difference matters to the front end in one specific way. `api/events.ts`
 * resets its backoff in `onopen`, so a socket that opened before being dropped
 * would reconnect at the 1 s floor forever; a refusal that never opens keeps
 * the backoff climbing to its 10 s ceiling. Same outcome, very different load.
 *
 * A missing `workspaces` table answers "no". That is the honest reading during
 * assembly, and it degrades the way a client can survive: 404, backoff, retry.
 */

import type { DatabaseSync } from "node:sqlite";

export function workspaceExists(
  database: DatabaseSync,
  workspaceId: string,
): boolean {
  if (workspaceId.length === 0) return false;
  try {
    const row = database
      .prepare("SELECT 1 FROM workspaces WHERE id = ?")
      .get(workspaceId);
    return row !== undefined;
  } catch {
    return false;
  }
}
