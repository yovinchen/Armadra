/**
 * Finding servers on the execution host — design §1.2.
 *
 * The rule that makes this module worth having: **a file existing is not a
 * discovery.** `rustup` installs a `rust-analyzer` proxy on PATH whether or
 * not the component is present, and running it prints
 * `Unknown binary 'rust-analyzer' in official toolchain` and exits non-zero.
 * So the probe runs `--version`, and only exit code 0 counts as found.
 * Everything else is `server_probe_failed`, which is a different answer from
 * `server_not_found` and from "available" — never conflated into either.
 *
 * Discovery never starts a language server. `--version` is the core's own
 * fixed command with a closed stdin, an 8 s deadline and a 64 KiB output
 * budget; it is not the project's code, which is why it may run even for a
 * workspace with no execute grant (the *result* is then marked
 * `execution_not_granted`).
 */

import { spawn } from "node:child_process";

import { resolveCommand } from "../agent/registry";
import type { SettingsStore } from "../settings";
import type { JsonObject, JsonValue } from "./jsonrpc";
import { reason } from "./limits";
import {
  candidate as registryCandidate,
  languages,
  type Feature,
  type ServerCandidate,
  type ServerDescriptor,
  type ServerState,
} from "./registry";
import { serverEnvironment } from "./server";
import { LanguageSettings } from "./settings";

/** A `--version` that has not answered by now is not going to. */
const PROBE_TIMEOUT_MS = 8_000;
/** Version banners are one line; anything past this is not a version. */
const MAX_OUTPUT = 64 * 1024;
/** Same cadence as the agent probe: a server upgraded today is seen tomorrow. */
export const PROBE_TTL_SECONDS = 24 * 60 * 60;

/**
 * One cached probe, stored under `settings.language.probes.<hostId>.<id>`.
 *
 * The database gains no table for this: it is a cache, and a cache that
 * survives as a settings key is one nobody has to migrate.
 */
export interface ServerProbe {
  readonly serverId: string;
  /**
   * The program the probe actually ran. A changed override re-probes rather
   * than inheriting the previous program's answer.
   */
  readonly program: string;
  /** Absolute path the lookup resolved; empty when nothing was found. */
  readonly executable: string;
  readonly version: string;
  /**
   * `ok` — ran and exited 0. `failed` — ran and did not. `missing` — the
   * program is not on this host at all. Three answers, never two.
   */
  readonly status: "ok" | "failed" | "missing";
  /** The exit code, when there was a process to get one from. */
  readonly exitCode: number | null;
  readonly probedAt: string;
}

function missingProbe(serverId: string, program: string): ServerProbe {
  return {
    serverId,
    program,
    executable: "",
    version: "",
    status: "missing",
    exitCode: null,
    probedAt: new Date().toISOString(),
  };
}

function probeState(probe: ServerProbe): {
  state: ServerState;
  reason?: string;
} {
  switch (probe.status) {
    case "ok":
      return { state: "available" };
    case "missing":
      return { state: "unsupported", reason: reason.SERVER_NOT_FOUND };
    default:
      return { state: "unsupported", reason: reason.SERVER_PROBE_FAILED };
  }
}

function probedAtUnixMs(probe: ServerProbe): number {
  const parsed = Date.parse(probe.probedAt);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/**
 * `agent_probe::parse_version`, character for character: the first run of
 * digits that starts a version-shaped token and has at least two segments.
 *
 * `sha256` and `utf8mb4` are rejected for having only one segment, and a run
 * that is already being walked is never restarted inside.
 */
export function parseVersion(output: string): string | undefined {
  const characters = [...output];
  let index = 0;
  const isDigit = (value: string | undefined): boolean =>
    value !== undefined && value >= "0" && value <= "9";
  while (index < characters.length) {
    if (!isDigit(characters[index])) {
      index += 1;
      continue;
    }
    const previous = characters[index - 1];
    if (index > 0 && (isDigit(previous) || previous === ".")) {
      index += 1;
      continue;
    }
    const segments: string[] = [];
    let cursor = index;
    while (segments.length < 3 && isDigit(characters[cursor])) {
      const start = cursor;
      while (isDigit(characters[cursor])) cursor += 1;
      segments.push(characters.slice(start, cursor).join(""));
      if (characters[cursor] === "." && isDigit(characters[cursor + 1])) {
        cursor += 1;
      } else {
        break;
      }
    }
    if (segments.length >= 2) {
      while (segments.length < 3) segments.push("0");
      return segments.join(".");
    }
    index = Math.max(cursor, index + 1);
  }
  return undefined;
}

/**
 * Runs `<program> --version` with stdin closed, a deadline and an output cap.
 *
 * The exit status is part of the answer, not just the output: a program that
 * printed a banner and then failed did not succeed.
 */
async function runVersion(
  program: string,
): Promise<
  { success: boolean; exitCode: number | null; output: string } | undefined
> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(program, ["--version"], {
        stdio: ["ignore", "pipe", "pipe"],
        env: serverEnvironment(),
        windowsHide: true,
        shell: false,
      });
    } catch {
      resolve(undefined);
      return;
    }
    let out = "";
    let err = "";
    let settled = false;
    const finish = (
      value:
        | { success: boolean; exitCode: number | null; output: string }
        | undefined,
    ): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill("SIGKILL");
      } catch {
        // Already gone.
      }
      resolve(value);
    };
    const timer = setTimeout(() => finish(undefined), PROBE_TIMEOUT_MS);
    child.stdout?.on("data", (chunk: Buffer) => {
      if (out.length < MAX_OUTPUT) out += chunk.toString("utf8");
    });
    // Some servers print their banner on stderr; both are read, and the exit
    // code decides whether any of it counts.
    child.stderr?.on("data", (chunk: Buffer) => {
      if (err.length < MAX_OUTPUT) err += chunk.toString("utf8");
    });
    child.on("error", () => finish(undefined));
    child.on("close", (code) =>
      finish({
        success: code === 0,
        exitCode: code ?? null,
        output: `${out}\n${err}`,
      }),
    );
  });
}

/** Probes one candidate, ignoring any cached answer. */
export async function probe(
  candidate: ServerCandidate,
  program: string,
): Promise<ServerProbe> {
  const resolved = resolveCommand(program);
  if (resolved === undefined) return missingProbe(candidate.serverId, program);
  const now = new Date().toISOString();
  const answer = await runVersion(resolved);
  if (answer === undefined) {
    return {
      serverId: candidate.serverId,
      program,
      executable: resolved,
      version: "",
      status: "failed",
      exitCode: null,
      probedAt: now,
    };
  }
  return {
    serverId: candidate.serverId,
    program,
    executable: resolved,
    version: answer.success ? (parseVersion(answer.output) ?? "") : "",
    status: answer.success ? "ok" : "failed",
    exitCode: answer.exitCode,
    probedAt: now,
  };
}

function asObject(value: JsonValue | undefined): JsonObject | undefined {
  return value !== null &&
    value !== undefined &&
    typeof value === "object" &&
    !Array.isArray(value)
    ? value
    : undefined;
}

function stored(
  document: JsonValue,
  hostId: string,
  serverId: string,
): ServerProbe | undefined {
  const entry = asObject(
    asObject(asObject(asObject(document)?.["language"])?.["probes"])?.[hostId],
  )?.[serverId];
  const object = asObject(entry);
  if (object === undefined) return undefined;
  const status = object["status"];
  if (status !== "ok" && status !== "failed" && status !== "missing") {
    return undefined;
  }
  const exitCode = object["exitCode"];
  return {
    serverId:
      typeof object["serverId"] === "string" ? object["serverId"] : serverId,
    program: typeof object["program"] === "string" ? object["program"] : "",
    executable:
      typeof object["executable"] === "string" ? object["executable"] : "",
    version: typeof object["version"] === "string" ? object["version"] : "",
    status,
    exitCode: typeof exitCode === "number" ? exitCode : null,
    probedAt: typeof object["probedAt"] === "string" ? object["probedAt"] : "",
  };
}

/**
 * An unparsable timestamp is stale: re-probing is cheap, and trusting a date
 * we cannot read is how a permanently wrong answer sticks.
 */
function isStale(probedAt: string): boolean {
  const when = Date.parse(probedAt);
  if (Number.isNaN(when)) return true;
  return (Date.now() - when) / 1000 >= PROBE_TTL_SECONDS;
}

/** The program this candidate would actually run, after settings overrides. */
export function programFor(
  settings: LanguageSettings,
  candidate: ServerCandidate,
): string {
  const override = settings.server(candidate.serverId);
  return override.path === "" ? candidate.program : override.path;
}

/** The launch arguments, after settings overrides. */
export function argsFor(
  settings: LanguageSettings,
  candidate: ServerCandidate,
): string[] {
  const override = settings.server(candidate.serverId);
  return override.args.length === 0 ? [...candidate.args] : [...override.args];
}

/**
 * The resolved absolute path of a probed server, or `undefined` when the last
 * probe did not find one. The launcher uses this and never re-resolves a bare
 * name against whatever PATH a child would inherit.
 */
export function resolvedExecutable(
  store: SettingsStore,
  hostId: string,
  serverId: string,
): string | undefined {
  const probe = stored(store.snapshot() as JsonValue, hostId, serverId);
  if (probe === undefined) return undefined;
  return probe.status === "ok" && probe.executable !== ""
    ? probe.executable
    : undefined;
}

async function cached(
  store: SettingsStore,
  settings: LanguageSettings,
  hostId: string,
  candidate: ServerCandidate,
  refresh: boolean,
  persist: boolean,
): Promise<ServerProbe> {
  const program = programFor(settings, candidate);
  if (!refresh) {
    const entry = stored(
      store.snapshot() as JsonValue,
      hostId,
      candidate.serverId,
    );
    if (
      entry !== undefined &&
      entry.program === program &&
      !isStale(entry.probedAt)
    ) {
      return entry;
    }
  }
  const fresh = await probe(candidate, program);
  // A failed patch only costs a re-probe next time; it must never fail the
  // request that triggered it.
  if (persist) {
    try {
      store.patch({
        language: {
          probes: { [hostId]: { [candidate.serverId]: { ...fresh } } },
        },
      });
    } catch {
      // The data directory may be read-only. The probe still answers.
    }
  }
  return fresh;
}

/**
 * Why, if at all, this workspace may not run servers. `undefined` means it may.
 *
 * The gate is `execute`, not `write`: starting a language server runs the
 * project's own build scripts, plugins and `cargo check` (design §3.1).
 */
export function executionReason(allowExecute: boolean): string | undefined {
  return allowExecute ? undefined : reason.EXECUTION_NOT_GRANTED;
}

function blank(
  languageId: string,
  extensions: readonly string[],
  candidate: ServerCandidate,
): ServerDescriptor {
  return {
    serverId: candidate.serverId,
    languageId,
    fileExtensions: [...extensions],
    executable: "",
    version: "",
    state: "unsupported",
    reason: reason.SERVER_NOT_FOUND,
    features: [...candidate.features],
    restartCount: 0,
    pid: null,
    startTimeUnixMs: null,
    openDocuments: 0,
    probedAtUnixMs: 0,
  };
}

/**
 * Every language's best candidate on this execution host.
 *
 * One row per language, always — a language whose server is missing is listed
 * as `unsupported` with a reason rather than omitted, because "we looked and
 * it is not there" is what the settings page has to be able to say.
 */
export async function discover(
  store: SettingsStore,
  hostId: string,
  allowExecute: boolean,
  refresh: boolean,
  persist: boolean,
): Promise<ServerDescriptor[]> {
  const settings = LanguageSettings.fromDocument(store.snapshot() as JsonValue);
  const gate = executionReason(allowExecute);
  const rows: ServerDescriptor[] = [];
  for (const entry of languages()) {
    let best: ServerDescriptor | undefined;
    for (const candidate of entry.candidates) {
      const override = settings.server(candidate.serverId);
      let descriptor: ServerDescriptor;
      if (!override.enabled) {
        descriptor = {
          ...blank(entry.languageId, entry.extensions, candidate),
          state: "unsupported",
          reason: reason.DISABLED,
        };
      } else {
        const result = await cached(
          store,
          settings,
          hostId,
          candidate,
          refresh,
          persist,
        );
        const { state, reason: why } = probeState(result);
        descriptor = {
          ...blank(entry.languageId, entry.extensions, candidate),
          executable: result.executable,
          version: result.version,
          state,
          ...(why === undefined ? {} : { reason: why }),
          probedAtUnixMs: probedAtUnixMs(result),
        };
        if (why === undefined) descriptor = withoutReason(descriptor);
      }
      const usable = descriptor.state === "available";
      // The first candidate that probes cleanly wins; otherwise the first one
      // seen is what the row reports, so the reason names the preferred server
      // rather than the last fallback.
      if (usable || best === undefined) best = descriptor;
      if (usable) break;
    }
    // The execute gate is applied to the chosen row, not to the choice.
    // Applying it earlier would make every candidate look unusable and the row
    // would name the *first* server rather than the one this machine actually
    // has.
    if (best === undefined) continue;
    if (best.state === "available" && gate !== undefined) {
      // The path and the version stay: hiding them would look like the server
      // is missing rather than not permitted.
      best = { ...best, state: "unsupported", reason: gate };
    }
    rows.push(best);
  }
  return rows;
}

function withoutReason(descriptor: ServerDescriptor): ServerDescriptor {
  const { reason: _omitted, ...rest } = descriptor;
  return rest;
}

/** The features a descriptor claims before it has ever been started. */
export function declaredFeatures(serverId: string): Feature[] {
  return [...(registryCandidate(serverId)?.candidate.features ?? [])];
}
