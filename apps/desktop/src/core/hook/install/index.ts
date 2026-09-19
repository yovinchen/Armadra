import { join } from "node:path";
import * as claude from "./claude";
import * as codex from "./codex";
import * as copilot from "./copilot";
import {
  installOpencode,
  installPi,
  modulePath,
  uninstallModule,
} from "./extensions";
import {
  type InstallReport,
  InstallError,
  configHome,
  injectionMode,
} from "./shared";

export * from "./events";
export * from "./shared";
export { modulePath, piExtensionPath, opencodePluginPath } from "./extensions";
export { hookHash, hooksPath as codexHooksPath, configPath as codexConfigPath } from "./codex";
export { hooksPath as copilotHooksPath } from "./copilot";
export { managedSettingsPath, settingsPath as claudeSettingsPath } from "./claude";

/**
 * The installers, dispatched by provider.
 *
 * `integrationHome` is our own data directory's `integration/<agentId>` — the
 * only provider that uses it is claude, whose adapter is a settings file we
 * own and point `--settings` at rather than anything under `~/.claude`.
 */
export function integrationDir(dataDir: string, agentId: string): string {
  return join(dataDir, "integration", agentId);
}

export function install(
  agentId: string,
  clientBin: string,
  dataDir: string,
  home: string = configHome(agentId),
): InstallReport {
  switch (agentId) {
    case "claude":
      return claude.install(home, integrationDir(dataDir, agentId), clientBin);
    case "codex":
      return codex.install(home, clientBin);
    case "copilot":
      return copilot.install(home, clientBin);
    case "opencode":
      return installOpencode(home, clientBin);
    case "pi":
    case "omp":
      return installPi(agentId, home, clientBin);
    default:
      throw new InstallError(
        400,
        "bad_request",
        `${agentId} has no hook installer`,
      );
  }
}

export function uninstall(
  agentId: string,
  dataDir: string,
  home: string = configHome(agentId),
): InstallReport {
  switch (agentId) {
    case "claude":
      return claude.uninstall(home, integrationDir(dataDir, agentId));
    case "codex":
      return codex.uninstall(home);
    case "copilot":
      return copilot.uninstall(home);
    case "opencode":
    case "pi":
    case "omp":
      return uninstallModule(agentId, home);
    default:
      throw new InstallError(
        400,
        "bad_request",
        `${agentId} has no hook installer`,
      );
  }
}

/**
 * Where a provider's adapter lives, and therefore what "installed" is read
 * from.
 *
 * One rule for every provider: **the file exists and names our client**. That
 * is true of a generated module, of our own file in Copilot's hook directory,
 * and of a `settings.json` we wrote — and it stays true when a user edits the
 * file by hand, which a row would not.
 */
export function adapterPath(
  agentId: string,
  home: string,
  dataDir: string,
): string {
  switch (agentId) {
    case "claude":
      return claude.managedSettingsPath(integrationDir(dataDir, agentId));
    case "codex":
      return codex.hooksPath(home);
    case "copilot":
      return copilot.hooksPath(home);
    case "opencode":
    case "pi":
    case "omp":
      return modulePath(agentId, home);
    default:
      throw new InstallError(
        400,
        "bad_request",
        `${agentId} has no hook installer`,
      );
  }
}

/**
 * The launch argv a session of this provider must carry. Empty unless the
 * provider is injected at launch *and* the integration is installed.
 */
export function launchArgs(agentId: string, dataDir: string): string[] {
  if (injectionMode(agentId) !== "launch") return [];
  return claude.launchArgs(
    claude.managedSettingsPath(integrationDir(dataDir, agentId)),
  );
}
