import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  HOOK_CLIENT_REVISION,
  OMP_CONTEXT_EVENTS,
  OMP_HOOK_EVENTS,
  OPENCODE_CONTEXT_EVENTS,
  PI_CONTEXT_EVENTS,
  PI_HOOK_EVENTS,
} from "./events";
import { opencodePluginSource, piExtensionSource } from "./extension-template";
import {
  type InstallReport,
  isManagedCommand,
  removedReport,
  writeAtomically,
} from "./shared";

/**
 * The three providers whose adapter is a generated module rather than a hook
 * entry: opencode, Pi and Oh My Pi.
 *
 * None of them has hook configuration at all. opencode exposes one `event` bus
 * to plugins; Pi and its fork expose `pi.on(event, handler)` to extensions
 * they auto-discover. So the "installer" writes one module into a directory
 * the CLI scans and the "uninstaller" deletes it: there is no shared file to
 * merge into and therefore nothing of the user's to preserve — except other
 * modules, which live in their own files and are never touched.
 *
 * Every module is gated on `ARMADRA_NODE_ID`: in a terminal the user opened
 * themselves the variable is absent, nothing is registered, and the CLI
 * behaves exactly as if the file were not there.
 *
 * Neither is session-scoped (agent-integration §3), and both for reasons that
 * were checked rather than assumed. Pi does have `pi --extension <path>`, and
 * it is deliberately unused: what §3 keeps out of is the user's **global
 * configuration**, and this file is not in it — it is a file only we write, in
 * a directory Pi scans, gated so that it does nothing outside a canvas node.
 * opencode's own entry point could not be started on the development machine
 * on 2026-09-13 (`opencode --help` exits with "opencode-ai's postinstall
 * script was not run"), so whether it has a session-level configuration that
 * could carry this module was not verifiable, and a flag nobody has run is not
 * a claim.
 */

/** Fixed so a reinstall overwrites its own file and never a stranger's. */
export const PI_EXTENSION_FILE = "armadra-status.ts";
export const OPENCODE_PLUGIN_FILE = "armadra-status.js";

/** Pi's skills root is `<agent dir>/skills`, read off Pi's own `core/skills.js`. */
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

function installed(agentId: string, path: string, clientBin: string): InstallReport {
  return {
    agentId,
    configPath: path,
    clientBin,
    clientRevision: HOOK_CLIENT_REVISION,
    installed: true,
    launchArgs: [],
  };
}

export function installPi(
  agentId: string,
  configHome: string,
  clientBin: string,
): InstallReport {
  const path = piExtensionPath(configHome);
  const events = agentId === "omp" ? OMP_HOOK_EVENTS : PI_HOOK_EVENTS;
  const context = agentId === "omp" ? OMP_CONTEXT_EVENTS : PI_CONTEXT_EVENTS;
  writeAtomically(path, piExtensionSource(agentId, clientBin, events, context));
  return installed(agentId, path, clientBin);
}

export function installOpencode(
  configHome: string,
  clientBin: string,
): InstallReport {
  const path = opencodePluginPath(configHome);
  writeAtomically(
    path,
    opencodePluginSource("opencode", clientBin, OPENCODE_CONTEXT_EVENTS),
  );
  return installed("opencode", path, clientBin);
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
