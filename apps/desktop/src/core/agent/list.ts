import { state as integrationState } from "../hook/install/integration";
import {
  type AgentInfo,
  type AgentSettings,
  customInfo,
  detect,
} from "./registry";

/**
 * `GET /api/agents` — the six built-in adapters plus the user's `custom:`
 * entries, each one answered against *this* machine and *this* data directory.
 *
 * Three halves, and none of them may be frozen into a definition:
 *
 *   * the registry row (id, label, colour, prompt mode, capabilities) is
 *     static;
 *   * `installed` / `resolvedPath` are this box's PATH, probed per request
 *     because a CLI installed a minute ago must appear without a restart;
 *   * `clientRevision`, `skillsRevision` and `launchArgs` are the integration's
 *     — `--settings <file>` names a path inside the running data directory, so
 *     it is answered now rather than remembered (docs/guides/agent-collaboration.md,
 *     "启动参数由 `GET /api/agents` 的 `launchArgs` 给出").
 *
 * A revision is **omitted** rather than zeroed when its half is not installed:
 * the page draws "not integrated" from the field's absence, and a `0` would
 * read as "integrated, by a build older than every revision".
 */
export interface ListAgentsOptions {
  readonly dataDir: string;
  readonly settings: AgentSettings;
  readonly env?: NodeJS.ProcessEnv;
}

export interface AgentListRow extends AgentInfo {
  readonly clientRevision?: number;
  readonly skillsRevision?: number;
  readonly launchArgs?: readonly string[];
}

export function listAgents(options: ListAgentsOptions): AgentListRow[] {
  const rows: AgentInfo[] = [
    ...detect(),
    ...options.settings.customAgents().map((custom) => customInfo(custom)),
  ];
  return rows.map((row) => withIntegration(row, options));
}

/**
 * The integration half of one row.
 *
 * A `custom:` entry borrows its base adapter's integration: the files on disk
 * belong to the CLI, not to the label the user gave it, so a custom Claude
 * reports the same revisions and the same `--settings` argv as Claude itself.
 *
 * Reading it must never take the list down. An unreadable config home is the
 * normal state of a CLI that is not installed, and the answer for it is a row
 * with no revisions — not a 500 that empties the new-node menu.
 */
function withIntegration(
  row: AgentInfo,
  options: ListAgentsOptions,
): AgentListRow {
  const provider = row.baseAgent ?? row.id;
  let state;
  try {
    state = integrationState(provider, {
      dataDir: options.dataDir,
      ...(options.env === undefined ? {} : { env: options.env }),
    });
  } catch {
    return row;
  }
  return {
    ...row,
    ...(state.hook.installed ? { clientRevision: state.hook.revision } : {}),
    ...(state.skill.installed ? { skillsRevision: state.skill.revision } : {}),
    ...(state.launchArgs.length > 0 ? { launchArgs: state.launchArgs } : {}),
  };
}
