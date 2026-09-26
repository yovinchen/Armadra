import { existsSync } from "node:fs";
import { configPath as codexConfigPath } from "./codex";
import {
  HOOK_CLIENT_REVISION,
  INTEGRATION_REVISION,
  SKILLS_REVISION,
} from "./events";
import {
  type InjectionOptions,
  artifactLayout,
  canvasInjection,
  codexTrusted,
  globalWritesDisabled,
  isInjected,
  prepareInjection,
  readMarker,
  removeInjection,
} from "./inject";
import {
  type MigrationRecord,
  migrateGlobalInstalls,
  readMigration,
} from "./migrate";
import { type LegacyFinding, scanIn } from "./repair";
import {
  type ClientEnvironment,
  InstallError,
  configHome,
  describe,
  hookCommand,
} from "./shared";
import { revisionOf } from "./skills";

/**
 * What the settings page reads and does for one CLI's integration
 * (docs/design/canvas-only-integration.md §5).
 *
 * There is no "install into the CLI" any more: hook, skill and canvas
 * instructions are artifacts under our data directory that only a canvas
 * launch hands over. So the state answers "are the artifacts current" and the
 * one action is "regenerate them". Two things are still about the CLI's own
 * configuration, and both are reported rather than hidden: Codex's trust
 * records (the only global write, named in {@link IntegrationState.globalWrites})
 * and what the one-time migration took out of the old global install.
 */

/** Half of the integration, as the settings page reads it. */
export interface IntegrationPart {
  readonly installed: boolean;
  /** The artifact this half lives in, present or not. */
  readonly path?: string;
  /** The revision on disk; `0` when this half is missing. */
  readonly revision: number;
}

/** What the migration did for this CLI — the page's "cleaned up" badge. */
export interface MigrationSummary {
  readonly migratedAt: string;
  readonly removed: readonly string[];
  readonly backups: readonly string[];
  readonly error?: string;
}

/** `GET /api/agents/{id}/integration`. */
export interface IntegrationState {
  readonly agentId: string;
  /** Always `canvas`: injected into canvas launches only. */
  readonly mode: string;
  readonly hook: IntegrationPart;
  readonly skill: IntegrationPart;
  readonly legacy: { readonly found: readonly LegacyFinding[] };
  /** The revision a regeneration writes. */
  readonly revision: number;
  /** The revision the artifacts on disk were written by. */
  readonly installedRevision?: number;
  /** Written by an older Armadra; the next launch rewrites them anyway. */
  readonly stale: boolean;
  /** Argv a canvas launch of this CLI carries, literal. */
  readonly launchArgs: readonly string[];
  /** The same as words for a typed launch line (see `inject.ts`). */
  readonly launchWords: readonly string[];
  /** Names of the environment variables a canvas launch sets. */
  readonly launchEnv: readonly string[];
  /** Files outside our data directory this integration writes. */
  readonly globalWrites: readonly string[];
  readonly migration?: MigrationSummary;
  /** Absolute path of the hook client the artifacts name. */
  readonly clientBin?: string;
  readonly warning?: string;
}

export interface IntegrationOptions {
  readonly dataDir: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly client?: ClientEnvironment;
  /** The CLI's config home; resolved from the environment when absent. */
  readonly home?: string;
  readonly now?: () => Date;
}

function requireInjected(agentId: string): void {
  if (!isInjected(agentId)) {
    throw new InstallError(
      400,
      "bad_request",
      `${agentId} has no canvas injection`,
    );
  }
}

function injectionOptions(
  agentId: string,
  options: IntegrationOptions,
): InjectionOptions {
  return {
    dataDir: options.dataDir,
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.client === undefined ? {} : { client: options.client }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(agentId === "codex" && options.home !== undefined
      ? { codexHome: options.home }
      : {}),
  };
}

function migrationFor(
  record: MigrationRecord | undefined,
  agentId: string,
): MigrationSummary | undefined {
  const entry = record?.agents[agentId];
  if (record === undefined || entry === undefined) return undefined;
  return {
    migratedAt: record.migratedAt,
    removed: entry.removed,
    backups: entry.backups,
    ...(entry.error === undefined ? {} : { error: entry.error }),
  };
}

function isPresent(path: string | undefined): boolean {
  return path !== undefined && existsSync(path);
}

/* --------------------------------- reading -------------------------------- */

export function state(
  agentId: string,
  options: IntegrationOptions,
  warning?: string,
): IntegrationState {
  requireInjected(agentId);
  const env = options.env ?? process.env;
  const home = options.home ?? configHome(agentId, env);
  const layout = artifactLayout(options.dataDir, agentId);
  const marker = readMarker(options.dataDir, agentId);
  const hookFile =
    layout.settings ?? layout.module ?? layout.pluginHooks ?? layout.marker;
  const trusted =
    agentId !== "codex" ||
    (marker !== undefined &&
      codexTrusted(home, hookCommand(marker.clientBin, agentId)));
  const hookInstalled = marker !== undefined && isPresent(hookFile) && trusted;
  const skillRevision = revisionOf(layout.skill);
  const injection = canvasInjection({ dataDir: options.dataDir, agentId });
  const migration = migrationFor(readMigration(options.dataDir), agentId);
  return {
    agentId,
    mode: "canvas",
    hook: {
      installed: hookInstalled,
      path: agentId === "codex" ? codexConfigPath(home) : hookFile,
      revision: hookInstalled ? HOOK_CLIENT_REVISION : 0,
    },
    skill: {
      installed: skillRevision !== undefined,
      path: layout.skill,
      revision: skillRevision ?? 0,
    },
    legacy: { found: scanIn(agentId, home) },
    revision: INTEGRATION_REVISION,
    stale: marker !== undefined && marker.revision !== INTEGRATION_REVISION,
    ...(marker === undefined ? {} : { installedRevision: marker.revision }),
    launchArgs: injection.args,
    launchWords: injection.words,
    launchEnv: injection.env.map(([name]) => name),
    globalWrites: agentId === "codex" ? [codexConfigPath(home)] : [],
    ...(migration === undefined ? {} : { migration }),
    ...(marker === undefined ? {} : { clientBin: marker.clientBin }),
    ...(warning === undefined ? {} : { warning }),
  };
}

/* -------------------------------- writing --------------------------------- */

/**
 * `POST …/integration/install`: regenerate the artifacts (and Codex's trust
 * records) now, whatever the marker says.
 */
export function install(
  agentId: string,
  options: IntegrationOptions,
): IntegrationState {
  requireInjected(agentId);
  prepareInjection(agentId, {
    ...injectionOptions(agentId, options),
    force: true,
  });
  return state(agentId, options);
}

/** `POST …/integration/uninstall`: remove the artifacts and trust records. */
export function uninstall(
  agentId: string,
  options: IntegrationOptions,
): IntegrationState {
  requireInjected(agentId);
  removeInjection(agentId, injectionOptions(agentId, options));
  return state(agentId, options);
}

/* -------------------------------- start-up -------------------------------- */

export interface StartupReport {
  readonly migration?: MigrationRecord;
  readonly prepared: readonly string[];
  readonly failures: readonly { agentId: string; error: string }[];
}

/**
 * What core start-up does: the one-time migration, then every CLI's artifacts
 * made current. Codex's trust records are written only when Codex has a
 * config home here — a machine that never ran Codex gets no `~/.codex`.
 *
 * Nothing global happens when {@link globalWritesDisabled}: the test suite's
 * cores run with the developer's real `HOME`.
 */
export function prepareAtStartup(options: IntegrationOptions): StartupReport {
  const env = options.env ?? process.env;
  const global = !globalWritesDisabled(env);
  const migration = global
    ? migrateGlobalInstalls({
        dataDir: options.dataDir,
        env,
        ...(options.now === undefined ? {} : { now: options.now }),
      })
    : undefined;
  const prepared: string[] = [];
  const failures: { agentId: string; error: string }[] = [];
  for (const agentId of [
    "claude",
    "codex",
    "opencode",
    "pi",
    "omp",
    "copilot",
  ]) {
    try {
      const codexHome = configHome("codex", env);
      prepareInjection(agentId, {
        ...injectionOptions(agentId, options),
        ...(agentId === "codex" && !existsSync(codexHome)
          ? { skipTrust: true }
          : {}),
      });
      prepared.push(agentId);
    } catch (error) {
      failures.push({ agentId, error: describe(error) });
    }
  }
  return {
    ...(migration === undefined ? {} : { migration }),
    prepared,
    failures,
  };
}

export { HOOK_CLIENT_REVISION, INTEGRATION_REVISION, SKILLS_REVISION };
