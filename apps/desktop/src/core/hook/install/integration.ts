import { readFileSync, rmSync, rmdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  HOOK_CLIENT_REVISION,
  INTEGRATION_REVISION,
  SKILLS_REVISION,
} from "./events";
import {
  adapterPath,
  install as installHook,
  integrationDir,
  launchArgs,
  uninstall as uninstallHook,
} from "./index";
import { type LegacyFinding, scanIn } from "./repair";
import {
  type ClientEnvironment,
  type InstallReport,
  configHome,
  injectionMode,
  isManagedCommand,
  resolveClientBinary,
  writeAtomically,
} from "./shared";
import { installedRevision, skillFile, skillInstaller } from "./skills";

/**
 * Hook and skill as **one** install unit
 * (docs/design/agent-integration.md §2, §5).
 *
 * Before this module a CLI had two switches and three states: hooks installed
 * but no skill, a skill with no hooks, and either of them stale. The user's
 * report that "installing failed" turned out to be several different things at
 * once, and no single screen could say which. So: one `install`, one
 * `uninstall`, one status, and one revision — {@link INTEGRATION_REVISION},
 * the hook revision and the skill revision folded together, so that either one
 * moving asks for one reinstall.
 *
 * ## What "installed" means
 *
 * The files on disk, never a row. An install writes two things — the adapter
 * (whose shape is each provider's own) and `skills/armadra/SKILL.md` — plus a
 * marker recording which revision wrote them. A user who deletes any of them
 * by hand sees that on the next read, with nothing having to notice.
 *
 * The marker exists because the adapter cannot carry a revision: Codex hashes
 * its hook entries, so a field only we read would break the hash. It lives
 * beside our own files in the data directory and is removed with them.
 */

/** Half of an install unit, as the settings page reads it. */
export interface IntegrationPart {
  readonly installed: boolean;
  /**
   * The file this half lives in. Present even when not installed, so the page
   * can say *where* it would go.
   */
  readonly path?: string;
  /** The revision on disk; `0` when this half is not installed. */
  readonly revision: number;
}

/** `GET /api/agents/{id}/integration` (设计 §5). */
export interface IntegrationState {
  readonly agentId: string;
  /**
   * `launch` / `file` / `extension` — how the adapter reaches the CLI, and
   * therefore whether integrating writes a file the user also edits.
   */
  readonly mode: string;
  readonly hook: IntegrationPart;
  readonly skill: IntegrationPart;
  readonly legacy: { readonly found: readonly LegacyFinding[] };
  /** The revision a fresh install writes — the one the page compares against. */
  readonly revision: number;
  /**
   * The revision the files on disk were written by; absent when nothing is
   * installed.
   */
  readonly installedRevision?: number;
  /** Installed, but by an older Armadra. The page offers "reinstall". */
  readonly stale: boolean;
  /**
   * Argv this provider's launch line must carry; empty for every mode but
   * `launch`.
   */
  readonly launchArgs: readonly string[];
  /** Absolute path of the hook client the adapter invokes. */
  readonly clientBin?: string;
  /** Something worked but deserves a sentence in the settings page. */
  readonly warning?: string;
}

interface Marker {
  readonly revision: number;
  readonly hookRevision: number;
  readonly skillRevision: number;
  readonly configPath: string;
  readonly installedAt: string;
}

export interface IntegrationOptions {
  readonly dataDir: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly client?: ClientEnvironment;
  /** The CLI's config home; resolved from the environment when absent. */
  readonly home?: string;
  readonly now?: () => Date;
}

function markerPath(dataDir: string, agentId: string): string {
  return join(integrationDir(dataDir, agentId), "installed.json");
}

function readMarker(dataDir: string, agentId: string): Marker | undefined {
  try {
    return JSON.parse(
      readFileSync(markerPath(dataDir, agentId), "utf8"),
    ) as Marker;
  } catch {
    return undefined;
  }
}

function adapterInstalled(path: string): boolean {
  try {
    return isManagedCommand(readFileSync(path, "utf8"));
  } catch {
    return false;
  }
}

/* --------------------------------- reading -------------------------------- */

/** The whole state of one provider's integration, read from disk. */
export function state(
  agentId: string,
  options: IntegrationOptions,
  warning?: string,
): IntegrationState {
  const home = options.home ?? configHome(agentId, options.env);
  const adapter = adapterPath(agentId, home, options.dataDir);
  const hookInstalled = adapterInstalled(adapter);
  const marker = readMarker(options.dataDir, agentId);
  const skillRevision = installedRevision(home);

  const installed =
    marker !== undefined && hookInstalled && skillRevision !== undefined
      ? marker.revision
      : undefined;
  let clientBin: string | undefined;
  try {
    clientBin = resolveClientBinary({ env: options.env, ...options.client });
  } catch {
    clientBin = undefined;
  }
  return {
    agentId,
    mode: injectionMode(agentId),
    hook: {
      installed: hookInstalled,
      path: adapter,
      revision: hookInstalled ? (marker?.hookRevision ?? 0) : 0,
    },
    skill: {
      installed: skillRevision !== undefined,
      path: skillFile(home),
      revision: skillRevision ?? 0,
    },
    legacy: { found: scanIn(agentId, home) },
    revision: INTEGRATION_REVISION,
    stale: installed !== undefined && installed !== INTEGRATION_REVISION,
    ...(installed === undefined ? {} : { installedRevision: installed }),
    launchArgs: launchArgs(agentId, options.dataDir),
    ...(clientBin === undefined ? {} : { clientBin }),
    ...(warning === undefined ? {} : { warning }),
  };
}

/* -------------------------------- installing ------------------------------ */

/**
 * Writes both halves, then the marker. Idempotent: reinstalling an unchanged
 * integration rewrites the same bytes and leaves the skill's mtime alone.
 *
 * The skill half is the collaboration domain's to write; until it registers a
 * writer the hook half installs alone and the state reports the skill as not
 * installed, which is what the settings page draws.
 */
export function install(
  agentId: string,
  options: IntegrationOptions,
): IntegrationState {
  const home = options.home ?? configHome(agentId, options.env);
  const clientBin = resolveClientBinary({
    env: options.env,
    ...options.client,
  });
  const report: InstallReport = installHook(
    agentId,
    clientBin,
    options.dataDir,
    home,
  );
  skillInstaller()?.install(agentId, home);
  writeMarker(agentId, report, options);
  return state(agentId, { ...options, home }, report.warning);
}

/**
 * Removes both halves and the marker. A half that was never there is not an
 * error: the end state is what was asked for either way.
 */
export function uninstall(
  agentId: string,
  options: IntegrationOptions,
): IntegrationState {
  const home = options.home ?? configHome(agentId, options.env);
  const report = uninstallHook(agentId, options.dataDir, home);
  skillInstaller()?.uninstall(agentId, home);
  const marker = markerPath(options.dataDir, agentId);
  if (isFile(marker)) {
    rmSync(marker, { force: true });
    try {
      rmdirSync(integrationDir(options.dataDir, agentId));
    } catch {
      // Something else of ours is still in there; leave it.
    }
  }
  return state(agentId, { ...options, home }, report.warning);
}

function writeMarker(
  agentId: string,
  report: InstallReport,
  options: IntegrationOptions,
): void {
  const marker: Marker = {
    revision: INTEGRATION_REVISION,
    hookRevision: report.clientRevision,
    skillRevision: SKILLS_REVISION,
    configPath: report.configPath,
    installedAt: (options.now ?? (() => new Date()))().toISOString(),
  };
  writeAtomically(
    markerPath(options.dataDir, agentId),
    `${JSON.stringify(marker, null, 2)}`,
  );
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export { HOOK_CLIENT_REVISION, INTEGRATION_REVISION };
