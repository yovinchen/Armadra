/**
 * The closed candidate table — language service design §1.2 — and the wire
 * types every layer above it shares.
 *
 * Everything here is a constant. There is no discovery by scanning the machine
 * for things that look like language servers, no download and no install: a
 * server is a program the user already has, named here or named in their
 * settings, and nothing else is ever started.
 *
 * Candidates are ordered, and the first one that probes successfully wins. The
 * order is a statement about capability, not preference — `pyright` before
 * `ruff` because falling back to `ruff` narrows the answer to diagnostics,
 * formatting and code actions, which `features` says out loud rather than
 * letting the editor discover it by asking and getting nothing.
 */

import type { JsonValue } from "./jsonrpc";

/* ---------------------------------- types --------------------------------- */

/** Where one server is in its life (design §1.3). */
export type ServerState =
  /** Probed, not started. Discovery never starts anything. */
  | "available"
  /** `reason` says what is missing. */
  | "unsupported"
  | "starting"
  | "running"
  /** Stopped after an idle period; sessions and shadow documents survive. */
  | "idleStopped"
  | "crashed"
  /** A person stopped it, or a ceiling did. Never restarted on its own. */
  | "stopped"
  /** The remote link went away; this core holds nothing current. */
  | "disconnected";

/**
 * What a server answers. A feature that is absent is absent: the editor
 * registers no affordance rather than one that returns nothing.
 */
export type Feature =
  | "completion"
  | "diagnostics"
  | "hover"
  | "definition"
  | "references"
  | "rename"
  | "formatting"
  | "documentSymbol"
  | "workspaceSymbol"
  | "codeAction"
  | "signatureHelp";

/** What a person pressed on a server row. */
export type Control = "restart" | "stop";

/**
 * One candidate server for one language on this execution host. Mirrors
 * `LanguageServerDescriptor` in `language.proto` and
 * `languageServerDescriptorSchema` in `@armadra/shared`.
 */
export interface ServerDescriptor {
  readonly serverId: string;
  readonly languageId: string;
  readonly fileExtensions: readonly string[];
  /** Absolute path on this host; empty when nothing was found. */
  readonly executable: string;
  readonly version: string;
  readonly state: ServerState;
  /** Omitted entirely when there is nothing to say (`skip_serializing_if`). */
  readonly reason?: string;
  readonly features: readonly Feature[];
  readonly restartCount: number;
  /**
   * Only while the process is running. `null` is not zero: a pid of 0 would be
   * a process the resource panel could claim.
   */
  readonly pid: number | null;
  readonly startTimeUnixMs: number | null;
  readonly openDocuments: number;
  readonly probedAtUnixMs: number;
}

/** `GET /api/workspaces/{id}/language-service` (design §2.9). */
export interface LanguageServiceStatus {
  readonly status: "available" | "unavailable";
  readonly reason?: string;
  readonly executionHostId: string;
  readonly servers: readonly ServerDescriptor[];
}

/* -------------------------------- candidates ------------------------------- */

/** One program that can serve one language. */
export interface ServerCandidate {
  /** Stable id; also the settings key under `language.servers.<serverId>`. */
  readonly serverId: string;
  /** The program name looked up on PATH, or an absolute path from settings. */
  readonly program: string;
  /** Launch arguments. A fixed array, never assembled from user text. */
  readonly args: readonly string[];
  /** What this server is expected to answer before it has been started. */
  readonly features: readonly Feature[];
}

/** One language: what files it covers and who can serve it. */
export interface LanguageEntry {
  readonly languageId: string;
  /** Lowercase, without the dot. `go.mod` is matched by file name below. */
  readonly extensions: readonly string[];
  readonly candidates: readonly ServerCandidate[];
}

/** Everything a full server is expected to answer. */
const FULL: readonly Feature[] = [
  "completion",
  "diagnostics",
  "hover",
  "definition",
  "references",
  "rename",
  "formatting",
  "documentSymbol",
  "workspaceSymbol",
  "codeAction",
  "signatureHelp",
];

/**
 * `ruff server` is a linter with an LSP face. Claiming completion or rename
 * for it would put affordances in the editor that answer nothing.
 */
const LINT_ONLY: readonly Feature[] = [
  "diagnostics",
  "formatting",
  "codeAction",
];

/**
 * `marksman` does links, headings and symbols; preview stays with the renderer
 * the editor already has.
 */
const MARKDOWN: readonly Feature[] = [
  "completion",
  "definition",
  "references",
  "documentSymbol",
  "workspaceSymbol",
  "diagnostics",
];

/** Structural formats: diagnostics, completion and hover from a schema. */
const STRUCTURED: readonly Feature[] = [
  "completion",
  "diagnostics",
  "hover",
  "formatting",
  "documentSymbol",
];

export const LANGUAGES: readonly LanguageEntry[] = [
  {
    languageId: "typescript",
    extensions: ["ts", "tsx", "mts", "cts"],
    candidates: [
      {
        serverId: "typescript-language-server",
        program: "typescript-language-server",
        args: ["--stdio"],
        features: FULL,
      },
    ],
  },
  {
    languageId: "javascript",
    extensions: ["js", "jsx", "mjs", "cjs"],
    candidates: [
      {
        serverId: "typescript-language-server",
        program: "typescript-language-server",
        args: ["--stdio"],
        features: FULL,
      },
    ],
  },
  {
    languageId: "rust",
    extensions: ["rs"],
    candidates: [
      {
        serverId: "rust-analyzer",
        program: "rust-analyzer",
        args: [],
        features: FULL,
      },
    ],
  },
  {
    languageId: "go",
    extensions: ["go"],
    candidates: [
      { serverId: "gopls", program: "gopls", args: [], features: FULL },
    ],
  },
  {
    languageId: "python",
    extensions: ["py", "pyi"],
    candidates: [
      {
        serverId: "pyright",
        program: "pyright-langserver",
        args: ["--stdio"],
        features: FULL,
      },
      {
        serverId: "basedpyright",
        program: "basedpyright-langserver",
        args: ["--stdio"],
        features: FULL,
      },
      {
        serverId: "ruff",
        program: "ruff",
        args: ["server"],
        features: LINT_ONLY,
      },
    ],
  },
  {
    languageId: "json",
    extensions: ["json", "jsonc"],
    candidates: [
      {
        serverId: "vscode-json-language-server",
        program: "vscode-json-language-server",
        args: ["--stdio"],
        features: STRUCTURED,
      },
    ],
  },
  {
    languageId: "yaml",
    extensions: ["yaml", "yml"],
    candidates: [
      {
        serverId: "yaml-language-server",
        program: "yaml-language-server",
        args: ["--stdio"],
        features: STRUCTURED,
      },
    ],
  },
  {
    languageId: "markdown",
    extensions: ["md", "markdown"],
    candidates: [
      {
        serverId: "marksman",
        program: "marksman",
        args: ["server"],
        features: MARKDOWN,
      },
    ],
  },
];

/**
 * Whole file names that name a language on their own. Without these, `go.mod`
 * would be read as the extension `mod` and get no language at all.
 */
const FILE_NAMES: readonly (readonly [string, string])[] = [
  ["go.mod", "go"],
  ["go.sum", "go"],
  ["go.work", "go"],
];

export function languages(): readonly LanguageEntry[] {
  return LANGUAGES;
}

export function language(languageId: string): LanguageEntry | undefined {
  return LANGUAGES.find((entry) => entry.languageId === languageId);
}

/**
 * The language of a workspace-relative path, or `undefined` when nothing here
 * covers it. That is an answer: the editor opens the file with no session
 * rather than starting a server that would not understand it.
 */
export function languageIdFor(path: string): string | undefined {
  const parts = path.split(/[/\\]/);
  const name = parts[parts.length - 1] ?? path;
  const byName = FILE_NAMES.find(([file]) => file === name);
  if (byName !== undefined) return byName[1];
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return undefined;
  const extension = name.slice(dot + 1).toLowerCase();
  return LANGUAGES.find((entry) => entry.extensions.includes(extension))
    ?.languageId;
}

/** The candidate a server id belongs to, with the language that offers it. */
export function candidate(
  serverId: string,
): { entry: LanguageEntry; candidate: ServerCandidate } | undefined {
  for (const entry of LANGUAGES) {
    const found = entry.candidates.find((value) => value.serverId === serverId);
    if (found !== undefined) return { entry, candidate: found };
  }
  return undefined;
}

/**
 * The features an `InitializeResult.capabilities` object claims.
 *
 * A provider is present when its key is anything other than `false` or absent
 * — the spec lets a server answer `true` or an options object, and both mean
 * "yes".
 */
const PROVIDERS: readonly (readonly [string, Feature])[] = [
  ["completionProvider", "completion"],
  ["hoverProvider", "hover"],
  ["definitionProvider", "definition"],
  ["typeDefinitionProvider", "definition"],
  ["implementationProvider", "definition"],
  ["referencesProvider", "references"],
  ["renameProvider", "rename"],
  ["documentFormattingProvider", "formatting"],
  ["documentRangeFormattingProvider", "formatting"],
  ["documentSymbolProvider", "documentSymbol"],
  ["workspaceSymbolProvider", "workspaceSymbol"],
  ["codeActionProvider", "codeAction"],
  ["signatureHelpProvider", "signatureHelp"],
  ["diagnosticProvider", "diagnostics"],
];

export function featuresFromCapabilities(
  capabilities: JsonValue | undefined,
): Feature[] {
  const object =
    capabilities !== null &&
    capabilities !== undefined &&
    typeof capabilities === "object" &&
    !Array.isArray(capabilities)
      ? capabilities
      : {};
  const features: Feature[] = [];
  for (const [key, feature] of PROVIDERS) {
    const value = object[key];
    const present = value !== undefined && value !== false && value !== null;
    if (present && !features.includes(feature)) features.push(feature);
  }
  // Push diagnostics are not advertised at all: a server that pushes
  // `textDocument/publishDiagnostics` says so by doing it.
  if (!features.includes("diagnostics")) features.push("diagnostics");
  return features;
}
