/**
 * How many workspaces run on each execution host.
 *
 * The one cross-domain read in the settings domain, and the reason it is its
 * own file: the `workspaces` table belongs to the workspace domain, and this
 * asks it one aggregate question rather than reaching into its rows. The delete
 * refusal in `execution-hosts` is derived from the same number the settings
 * page shows, so it has to be the real count rather than one this domain kept
 * for itself.
 *
 * A missing table answers "none" instead of failing. The domains are installed
 * independently and in an order nobody should have to reason about; a core
 * whose workspace domain has not run its migrations yet should still be able to
 * list the machines it could run on.
 */

import type { DatabaseSync } from "node:sqlite";

const QUERY =
  "SELECT execution_host_id, count(*) AS total FROM workspaces GROUP BY execution_host_id";

export function workspaceCounts(database: DatabaseSync): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  let rows: Record<string, unknown>[];
  try {
    rows = database.prepare(QUERY).all() as Record<string, unknown>[];
  } catch {
    return counts;
  }
  for (const row of rows) {
    const id = row.execution_host_id;
    const total = row.total;
    if (typeof id !== "string") continue;
    // `count(*)` is an integer, and `node:sqlite` hands integers back as
    // `number` unless they do not fit — which a row count never will.
    const value = typeof total === "bigint" ? Number(total) : total;
    counts.set(id, typeof value === "number" && value > 0 ? value : 0);
  }
  return counts;
}
