/**
 * The settings domain: the preferences document, the local split, and the
 * execution host registry read out of it.
 *
 * Nine routes, all of them phase 1. `POST /api/execution-hosts/{id}/validate`
 * is the tenth in the table and is deliberately left at 501: it reaches a
 * machine over `ssh` and runs the Worker's version handshake, which is the
 * terminal and remote domains' half.
 */

import type { CoreContext } from "../main";
import { settingsFile, workerSettingsFile } from "../paths";
import {
  deleteExecutionHost,
  exportExecutionHosts,
  importExecutionHosts,
  listExecutionHosts,
  putExecutionHost,
  type ExecutionHostDeps,
} from "./execution-hosts";
import { getLocalSettings, getSettings, patchSettings } from "./routes";
import { SettingsStore } from "./store";
import { workspaceCounts } from "./workspace-counts";

export { SettingsStore } from "./store";
export type { JsonObject, JsonValue } from "./local";
export { isLocal, localPaths, LOCAL_PATHS } from "./local";
export { normalize, merge } from "./schema";
export { parseHosts, validateHost, type SshHost } from "./ssh-hosts";

/** The store this run assembled, so other domains can read a preference. */
export interface SettingsDomain {
  readonly settings: SettingsStore;
}

let assembled: SettingsDomain | undefined;

/**
 * The settings store of the running core.
 *
 * A module-level handle rather than something threaded through `CoreContext`,
 * because almost every domain reads a preference and almost none writes one:
 * putting the store in the context would make every signature carry it. It is
 * set by `install` and is undefined until then, which is exactly the window in
 * which nothing has started.
 */
export function settingsDomain(): SettingsDomain | undefined {
  return assembled;
}

export function install(context: CoreContext): SettingsDomain {
  const localFile = workerSettingsFile(context.dataDir);
  const settings = SettingsStore.load({
    sharedFile: settingsFile(context.dataDir),
    localFile,
    onError: (error) =>
      context.log.warn("could not write the settings document", {
        error: error instanceof Error ? error.message : String(error),
      }),
  });
  const deps = { settings, workerSettingsFile: localFile };
  const hosts: ExecutionHostDeps = {
    settings,
    workspaceCounts: () => workspaceCounts(context.db.database),
  };

  const { router } = context.server;
  router.handle("GET", "/api/settings", () => getSettings(deps));
  router.handle("PATCH", "/api/settings", (_match, request) =>
    patchSettings(deps, request),
  );
  router.handle("GET", "/api/settings/local", () => getLocalSettings(deps));

  router.handle("GET", "/api/execution-hosts", () => listExecutionHosts(hosts));
  router.handle("GET", "/api/execution-hosts/export", () =>
    exportExecutionHosts(hosts),
  );
  router.handle("POST", "/api/execution-hosts/import", (_match, request) =>
    importExecutionHosts(hosts, request),
  );
  router.handle("PUT", "/api/execution-hosts/{hostId}", (match, request) =>
    putExecutionHost(hosts, match.params.hostId ?? "", request),
  );
  router.handle("DELETE", "/api/execution-hosts/{hostId}", (match) =>
    deleteExecutionHost(hosts, match.params.hostId ?? ""),
  );

  assembled = { settings };
  return assembled;
}
