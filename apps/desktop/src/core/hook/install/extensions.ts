import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { HOOK_CLIENT_REVISION } from "./events";
import { type InstallReport, isManagedCommand, removedReport } from "./shared";

/**
 * The three providers whose adapter is a generated module rather than a hook
 * entry: opencode, Pi and Oh My Pi — and where an earlier Armadra put that
 * module globally, so the migration can take it back out.
 *
 * None of them has hook configuration at all. opencode exposes one `event` bus
 * to plugins; Pi and its fork expose `pi.on(event, handler)` to extensions.
 * The module is now handed over per launch (`inject.ts`): Pi `--extension`,
 * OMP `--extension=`, and for opencode an `OPENCODE_CONFIG_DIR` of ours with
 * the module in its `plugins/` — all measured on 2026-09-26. The global copies
 * the old installer wrote into the directories these CLIs scan are what
 * {@link uninstallModule} removes.
 *
 * Every module is still gated on `ARMADRA_NODE_ID`: belt and braces for a
 * user who copies one somewhere the CLI scans.
 */

/** Fixed so a reinstall overwrites its own file and never a stranger's. */
export const PI_EXTENSION_FILE = "armadra-status.ts";
export const OPENCODE_PLUGIN_FILE = "armadra-status.js";

/** Where the old installer put Pi's / OMP's module: `<agent dir>/extensions`. */
export function piExtensionPath(configHome: string): string {
  return join(configHome, "extensions", PI_EXTENSION_FILE);
}

export function opencodePluginPath(configHome: string): string {
  return join(configHome, "plugins", OPENCODE_PLUGIN_FILE);
}

/** Where a provider's generated module lives, installed or not. */
export function modulePath(agentId: string, configHome: string): string {
  return agentId === "opencode"
    ? opencodePluginPath(configHome)
    : piExtensionPath(configHome);
}

/**
 * Deletes the generated module — but only a file that is recognisably ours:
 * the name could have been taken over by something the user wrote.
 */
export function uninstallModule(
  agentId: string,
  configHome: string,
): InstallReport {
  const path = modulePath(agentId, configHome);
  try {
    if (isManagedCommand(readFileSync(path, "utf8"))) {
      rmSync(path, { force: true });
    }
  } catch {
    // Not there: the end state is what was asked for either way.
  }
  return removedReport(agentId, path, HOOK_CLIENT_REVISION);
}
