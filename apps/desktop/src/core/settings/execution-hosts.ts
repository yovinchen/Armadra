/**
 * `/api/execution-hosts` — the machines a workspace may run on.
 *
 * Ported from `apps/runtime/src/api/execution_hosts.rs`.
 *
 * An execution host is not a second store. It is `settings.ssh.hosts[]` read
 * out as an addressable object, so a client can create, rename, retire and
 * carry one without hand-editing a JSON array inside a preferences document —
 * and so a change to one host is a change to one thing, rather than "the
 * settings changed". Every write here goes through `SettingsStore.patch`, which
 * is the only writer; there is no path by which the two could disagree.
 *
 * Three rules the surface exists to enforce:
 *
 *  1. **This machine is always in the list and is never stored.** Its
 *     identifier is the empty string — the convention migration 0009 already
 *     uses for a local workspace — and it needs no registration, so it has no
 *     row, no revision and no delete.
 *  2. **Nothing that could be a credential travels.** The record holds where a
 *     host is and how the Worker is started there. `identityFile` is a path the
 *     host resolves against its own filesystem; there is no field a password,
 *     passphrase or key could be carried in, so an export is a configuration
 *     file rather than a secret.
 *  3. **A host in use is not deleted out from under its workspaces.** Removing
 *     one whose workspaces still point at it would leave those workspaces
 *     naming a machine nobody can reach, and the files are on it.
 *
 * `POST …/{id}/validate` is **not** here. It reaches a machine — `ssh … true`
 * plus the Worker version handshake — and reaching a machine is the terminal
 * and remote domains' half, which lands later. The route stays 501 with its
 * feature name until then, which is exactly what the 501 is for.
 */

import { badRequest, coreError, type ErrorResponse } from "../http/errors";
import type { CoreRequest, HandlerResult } from "../http/router";
import { isJsonObject, type JsonObject, type JsonValue } from "./local";
import { isParseFailure, readJsonBody } from "./routes";
import {
  MAX_HOSTS,
  hostToJson,
  parseHost,
  validateHost,
  type SshHost,
} from "./ssh-hosts";
import type { SettingsStore } from "./store";

/**
 * How many hosts one import may carry, matching the registry's own ceiling in
 * `ssh-hosts`.
 */
const MAX_IMPORT_HOSTS = MAX_HOSTS;

/**
 * The export's own shape version. An importer that does not recognise it
 * refuses rather than guessing, because guessing would mean writing a machine
 * registry from a file it could not read.
 */
const EXPORT_VERSION = 1;

/**
 * How many workspaces run on each execution host.
 *
 * A read of another domain's table, and the only one in this file. The
 * workspaces table belongs to the canvas and workspace domain; the delete
 * refusal below is derived from the same number the page shows, so it has to be
 * the real one rather than a count this domain kept for itself. A missing table
 * answers "none" instead of failing: a core whose workspace domain has not been
 * assembled yet should still be able to list the machines.
 */
export type WorkspaceCounts = () => ReadonlyMap<string, number>;

export interface ExecutionHostDeps {
  readonly settings: SettingsStore;
  readonly workspaceCounts: WorkspaceCounts;
}

/** One machine, as the settings page and the switch dialog read it. */
function view(
  host: SshHost | null,
  counts: ReadonlyMap<string, number>,
): JsonObject {
  if (host === null) {
    return {
      executionHostId: "",
      name: "",
      kind: "local",
      // Nothing to configure: this is where the core itself runs.
      workerConfigured: true,
      workspaceCount: counts.get("") ?? 0,
    };
  }
  return {
    executionHostId: host.id,
    name: host.name,
    kind: "ssh",
    ssh: hostToJson(host),
    // Without a worker the host runs terminals only: a workspace cannot execute
    // on it, and asking is `UNSUPPORTED` rather than a quiet fall back here.
    workerConfigured: host.worker !== undefined,
    workspaceCount: counts.get(host.id) ?? 0,
  };
}

/**
 * `GET /api/execution-hosts` — this machine first, then the SSH registry in the
 * order the document stores it.
 */
export function listExecutionHosts(deps: ExecutionHostDeps): HandlerResult {
  return { status: 200, body: listing(deps) };
}

function listing(deps: ExecutionHostDeps): JsonValue {
  const counts = deps.workspaceCounts();
  const hosts = parseRegistry(deps);
  return [view(null, counts), ...hosts.map((host) => view(host, counts))];
}

function parseRegistry(deps: ExecutionHostDeps): SshHost[] {
  const section = deps.settings.get("ssh.hosts");
  if (!Array.isArray(section)) return [];
  const hosts: SshHost[] = [];
  for (const entry of section) {
    const host = parseHost(entry);
    if (host === undefined || validateHost(host) !== null) continue;
    if (hosts.some((existing) => existing.id === host.id)) continue;
    hosts.push(host);
    if (hosts.length === MAX_HOSTS) break;
  }
  return hosts;
}

/**
 * The array is replaced whole: the merge only recurses into objects, so a
 * partial list would not be a partial write — it would be the new registry.
 */
function writeHosts(deps: ExecutionHostDeps, hosts: readonly SshHost[]): void {
  deps.settings.patch({ ssh: { hosts: hosts.map(hostToJson) } });
}

/* ---------------------------------- writes --------------------------------- */

/**
 * `PUT /api/execution-hosts/{id}` — create or replace one host.
 *
 * The whole entry is replaced rather than merged: a host is a small record that
 * is edited as a form, and a merge would make "clear the identity file"
 * impossible to express.
 */
export function putExecutionHost(
  deps: ExecutionHostDeps,
  hostId: string,
  request: CoreRequest,
): HandlerResult | ErrorResponse {
  const parsed = readJsonBody(request);
  if (isParseFailure(parsed)) return parsed;
  const host = parseHost(parsed.value ?? null);
  if (host === undefined) {
    return badRequest("The request body is not an execution host");
  }
  if (host.id !== hostId) {
    return badRequest(
      "The execution host id in the path and in the body must match",
    );
  }
  if (hostId.length === 0) {
    return badRequest("This machine is always available and is not registered");
  }
  // The same validation `normalize` applies, run here so a bad entry is a
  // refusal with a field name rather than an entry that silently disappears on
  // the next read.
  const invalid = validateHost(host);
  if (invalid !== null) {
    return badRequest(`Invalid execution host field: ${invalid}`);
  }
  const hosts = parseRegistry(deps);
  const index = hosts.findIndex((existing) => existing.id === host.id);
  if (index >= 0) {
    hosts[index] = host;
  } else {
    if (hosts.length >= MAX_IMPORT_HOSTS) {
      return badRequest(
        "This installation already holds as many execution hosts as it supports",
      );
    }
    hosts.push(host);
  }
  writeHosts(deps, hosts);
  return { status: 200, body: listing(deps) };
}

/** `DELETE /api/execution-hosts/{id}` — retire a host nothing runs on. */
export function deleteExecutionHost(
  deps: ExecutionHostDeps,
  hostId: string,
): HandlerResult | ErrorResponse {
  const hosts = parseRegistry(deps);
  if (!hosts.some((host) => host.id === hostId)) {
    return coreError(404, "not_found", "No such execution host");
  }
  const bound = deps.workspaceCounts().get(hostId) ?? 0;
  if (bound > 0) {
    // Deleting it would leave those workspaces naming a machine nothing can
    // reach, and their files are on it. Moving them is a decision, so it is
    // asked for rather than performed here.
    return coreError(
      409,
      "conflict",
      `${bound} workspace(s) still run on this execution host; move them before removing it`,
    );
  }
  writeHosts(
    deps,
    hosts.filter((host) => host.id !== hostId),
  );
  return { status: 200, body: listing(deps) };
}

/* ------------------------------ export / import ---------------------------- */

/**
 * `GET /api/execution-hosts/export` — the portable form of the registry.
 *
 * It carries where each host is and how the Worker is started there, and
 * nothing that could authenticate to it: there is no password or key field to
 * omit, and `identityFile` is a path each machine resolves against its own
 * filesystem. So this is a configuration file, and moving it between two of a
 * person's own machines does not move any secret.
 */
export function exportExecutionHosts(deps: ExecutionHostDeps): HandlerResult {
  return {
    status: 200,
    body: {
      version: EXPORT_VERSION,
      hosts: parseRegistry(deps).map(hostToJson),
    },
  };
}

/**
 * `POST /api/execution-hosts/import`.
 *
 * The whole package is validated before anything is written. A partial import —
 * some hosts in, one refused — would leave a registry nobody chose, and there
 * is no way to tell from the result which half landed.
 */
export function importExecutionHosts(
  deps: ExecutionHostDeps,
  request: CoreRequest,
): HandlerResult | ErrorResponse {
  const parsed = readJsonBody(request);
  if (isParseFailure(parsed)) return parsed;
  const body = parsed.value;
  if (!isJsonObject(body)) {
    return badRequest("The request body is not an execution host package");
  }
  // `deny_unknown_fields` on the Rust side: a package with a key this build
  // does not read is a package written to a different shape, and importing the
  // half of it we understand would be a registry nobody chose.
  for (const key of Object.keys(body)) {
    if (!["version", "hosts", "replace", "overwrite"].includes(key)) {
      return badRequest("The request body is not an execution host package");
    }
  }
  if (body.version !== EXPORT_VERSION) {
    return badRequest(
      "This execution host package was written to a shape this build does not read",
    );
  }
  if (!Array.isArray(body.hosts)) {
    return badRequest("The request body is not an execution host package");
  }
  if (body.hosts.length > MAX_IMPORT_HOSTS) {
    return badRequest(
      "The package holds more execution hosts than this installation supports",
    );
  }
  const incoming: SshHost[] = [];
  for (const entry of body.hosts) {
    const host = parseHost(entry);
    if (host === undefined) {
      return badRequest("The request body is not an execution host package");
    }
    const invalid = validateHost(host);
    if (invalid !== null) {
      return badRequest(
        `Execution host '${host.id}' has an invalid ${invalid}`,
      );
    }
    incoming.push(host);
  }
  const replace = body.replace === true;
  const overwrite = body.overwrite === true;
  const hosts = replace ? [] : parseRegistry(deps);
  for (const host of incoming) {
    const index = hosts.findIndex((existing) => existing.id === host.id);
    if (index >= 0) {
      if (!overwrite) {
        return coreError(
          409,
          "conflict",
          `Execution host '${host.id}' already exists; import with overwrite to replace it`,
        );
      }
      hosts[index] = host;
      continue;
    }
    hosts.push(host);
  }
  if (hosts.length > MAX_IMPORT_HOSTS) {
    return badRequest(
      "Importing these hosts would exceed the registry ceiling",
    );
  }
  writeHosts(deps, hosts);
  return { status: 200, body: listing(deps) };
}
