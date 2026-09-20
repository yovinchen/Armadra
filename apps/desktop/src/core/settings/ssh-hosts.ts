/**
 * `settings.ssh.hosts[]` — what may be configured about a remote machine.
 *
 * Ported from the validation half of the pre-merge implementation.
 * Only the half that reads and normalises the settings document lives here;
 * actually reaching a host (`probe_host`, the argv builder, `known_hosts`) is
 * the terminal domain's, and arrives with it.
 *
 * Two rules this file exists to enforce:
 *
 *  1. **Validation belongs to the core.** `settings.json` is a plain file a
 *     user can edit by hand, so `normalizeHosts` drops entries that do not pass
 *     rather than trusting the front end's own check.
 *  2. **argv, never a shell string.** Every field is validated to hold no
 *     whitespace and no shell metacharacter, so a host called `a;rm -rf /`
 *     could at worst become one meaningless argument — and it never gets that
 *     far.
 */

import { clone, isJsonObject, type JsonObject, type JsonValue } from "./local";

/** Ceilings that keep a hand-edited file from producing an absurd command line. */
export const MAX_HOSTS = 64;
const MAX_ID = 64;
const MAX_NAME = 64;
const MAX_HOST = 255;
const MAX_USER = 64;
const MAX_PATH = 4_096;
const MAX_EXTRA_ARGS = 16;
const MAX_EXTRA_ARG = 128;

/**
 * `-o` values that turn `ssh` into a local command runner, or that would let a
 * hand-edited settings file undo the host-key decision Armadra makes on the
 * user's behalf. Neither is shell injection — there is no shell — but the first
 * executes a program of the user's choosing at connect time and the second
 * silently re-enables the automatic trust the design exists to prevent.
 */
const FORBIDDEN_OPTIONS = [
  "proxycommand",
  "localcommand",
  "permitlocalcommand",
  "stricthostkeychecking",
  "userknownhostsfile",
  "globalknownhostsfile",
];

/**
 * Where the Armadra Worker binary lives on an SSH host, and where it may keep
 * its private state. Absent means this host runs terminals only.
 */
export interface SshWorker {
  readonly path: string;
  readonly stateDir?: string;
}

/** One entry of `settings.ssh.hosts[]`. */
export interface SshHost {
  readonly id: string;
  readonly name: string;
  readonly host: string;
  readonly user?: string;
  readonly port?: number;
  readonly identityFile?: string;
  readonly extraArgs?: readonly string[];
  readonly worker?: SshWorker;
}

/* -------------------------------- validation ------------------------------ */

function isId(value: string): boolean {
  return (
    value.length > 0 && value.length <= MAX_ID && /^[A-Za-z0-9_-]+$/.test(value)
  );
}

/** A DNS name / IPv4 literal, or an IPv6 literal in brackets (`[::1]`). */
function isHostname(value: string): boolean {
  if (value.length === 0 || value.length > MAX_HOST) return false;
  if (value.startsWith("[") && value.endsWith("]")) {
    const inner = value.slice(1, -1);
    return inner.length > 0 && /^[0-9A-Fa-f:.]+$/.test(inner);
  }
  return /^[A-Za-z0-9.-]+$/.test(value);
}

function isUser(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= MAX_USER &&
    /^[A-Za-z0-9._-]+$/.test(value)
  );
}

/**
 * No control character, no shell metacharacter, no whitespace. Applied to the
 * identity path and to every extra argument; the argv builder makes this belt
 * and braces, which is exactly the point.
 */
function isClean(value: string): boolean {
  if (value.length === 0) return false;
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    const isControl = code < 0x20 || (code >= 0x7f && code <= 0x9f);
    if (isControl) return false;
    if (/\s/u.test(character)) return false;
    if (";&|$`<>(){}*?!\\'\"".includes(character)) return false;
  }
  return true;
}

function hasControl(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

/**
 * `null`, or the field that is wrong. The name is a stable key-ish string used
 * by tests and logs; the UI validates the same rules itself.
 */
export function validateHost(host: SshHost): string | null {
  if (!isId(host.id)) return "id";
  if (
    host.name.trim().length === 0 ||
    [...host.name].length > MAX_NAME ||
    hasControl(host.name)
  ) {
    return "name";
  }
  if (!isHostname(host.host)) return "host";
  if (host.user !== undefined && !isUser(host.user)) return "user";
  if (host.port !== undefined && host.port === 0) return "port";
  const identity = host.identityFile;
  if (
    identity !== undefined &&
    (!identity.startsWith("/") ||
      identity.length > MAX_PATH ||
      !isClean(identity))
  ) {
    return "identityFile";
  }
  const extraArgs = host.extraArgs ?? [];
  if (extraArgs.length > MAX_EXTRA_ARGS) return "extraArgs";
  for (const argument of extraArgs) {
    if (
      !argument.startsWith("-") ||
      argument.length > MAX_EXTRA_ARG ||
      !isClean(argument) ||
      FORBIDDEN_OPTIONS.some((forbidden) =>
        argument.toLowerCase().includes(forbidden),
      )
    ) {
      return "extraArgs";
    }
  }
  const worker = host.worker;
  if (worker !== undefined) {
    // The remote command is words `ssh` joins with spaces and the login shell
    // then splits, so these paths must survive that round trip untouched:
    // absolute, no whitespace, no shell metacharacter.
    if (
      !worker.path.startsWith("/") ||
      worker.path.length > MAX_PATH ||
      !isClean(worker.path)
    ) {
      return "worker.path";
    }
    const stateDir = worker.stateDir;
    if (
      stateDir !== undefined &&
      (!stateDir.startsWith("/") ||
        stateDir.length > MAX_PATH ||
        !isClean(stateDir))
    ) {
      return "worker.stateDir";
    }
  }
  return null;
}

/* --------------------------------- parsing -------------------------------- */

function text(source: JsonObject, key: string): string | undefined {
  const value = source[key];
  return typeof value === "string" ? value : undefined;
}

/**
 * One raw entry → a typed host, or `undefined` when it could not even be read
 * as one. Deserialisation failure and validation failure are separate steps on
 * the Rust side too; both end in the entry being dropped.
 */
export function parseHost(raw: JsonValue): SshHost | undefined {
  if (!isJsonObject(raw)) return undefined;
  const id = text(raw, "id");
  const name = text(raw, "name");
  const host = text(raw, "host");
  if (id === undefined || name === undefined || host === undefined) {
    return undefined;
  }
  const port = raw.port;
  if (port !== undefined && port !== null) {
    if (
      typeof port !== "number" ||
      !Number.isInteger(port) ||
      port < 0 ||
      port > 65_535
    ) {
      // `u16` on the Rust side: a value that does not fit is not a host with a
      // bad port, it is a document that does not deserialise.
      return undefined;
    }
  }
  const extraArgsRaw = raw.extraArgs;
  let extraArgs: string[] | undefined;
  if (extraArgsRaw !== undefined && extraArgsRaw !== null) {
    if (!Array.isArray(extraArgsRaw)) return undefined;
    if (!extraArgsRaw.every((entry) => typeof entry === "string"))
      return undefined;
    extraArgs = extraArgsRaw as string[];
  }
  const workerRaw = raw.worker;
  let worker: SshWorker | undefined;
  if (workerRaw !== undefined && workerRaw !== null) {
    if (!isJsonObject(workerRaw)) return undefined;
    const path = text(workerRaw, "path");
    if (path === undefined) return undefined;
    const stateDir = text(workerRaw, "stateDir");
    worker = stateDir === undefined ? { path } : { path, stateDir };
  }
  const user = text(raw, "user");
  const identityFile = text(raw, "identityFile");
  return {
    id,
    name,
    host,
    ...(user === undefined ? {} : { user }),
    ...(port === undefined || port === null ? {} : { port: port as number }),
    ...(identityFile === undefined ? {} : { identityFile }),
    ...(extraArgs === undefined || extraArgs.length === 0 ? {} : { extraArgs }),
    ...(worker === undefined ? {} : { worker }),
  };
}

/**
 * Parses `settings.ssh.hosts[]`, dropping anything malformed or invalid and
 * de-duplicating ids (first wins).
 */
export function parseHosts(document: JsonValue): SshHost[] {
  if (!isJsonObject(document)) return [];
  const section = document.ssh;
  if (!isJsonObject(section)) return [];
  const list = section.hosts;
  if (!Array.isArray(list)) return [];
  const hosts: SshHost[] = [];
  for (const entry of list) {
    const host = parseHost(entry);
    if (host === undefined) continue;
    if (validateHost(host) !== null) continue;
    if (hosts.some((existing) => existing.id === host.id)) continue;
    hosts.push(host);
    if (hosts.length === MAX_HOSTS) break;
  }
  return hosts;
}

/** The serialised form, with the optional fields omitted exactly as serde does. */
export function hostToJson(host: SshHost): JsonObject {
  const json: JsonObject = { id: host.id, name: host.name, host: host.host };
  if (host.user !== undefined) json.user = host.user;
  if (host.port !== undefined) json.port = host.port;
  if (host.identityFile !== undefined) json.identityFile = host.identityFile;
  if (host.extraArgs !== undefined && host.extraArgs.length > 0) {
    json.extraArgs = [...host.extraArgs];
  }
  if (host.worker !== undefined) {
    const worker: JsonObject = { path: host.worker.path };
    if (host.worker.stateDir !== undefined)
      worker.stateDir = host.worker.stateDir;
    json.worker = worker;
  }
  return json;
}

/**
 * Rewrites `ssh.hosts` in place with the validated list, so a `GET
 * /api/settings` never hands the UI an entry the core would refuse to use.
 */
export function normalizeHosts(document: JsonObject): void {
  const hosts = parseHosts(document);
  const existing = document.ssh;
  const section: JsonObject = isJsonObject(existing) ? clone(existing) : {};
  section.hosts = hosts.map(hostToJson);
  document.ssh = section;
}
