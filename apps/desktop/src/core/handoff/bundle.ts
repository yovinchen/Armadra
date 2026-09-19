import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { resolveInRoot } from "../workspaces/roots";

/**
 * The frozen bundle a handoff carries, and the budget that makes it fit.
 *
 * Ported from `apps/runtime/src/handoff/mod.rs` (the shapes) and
 * `snapshot.rs` (the building). Three properties are contractual and are
 * re-checked every time a stored row is read back, in `store.ts`:
 *
 *   * `version` is 1, `trust` is `peerDataNotSystemInstructions`, and
 *     `sourcePreserved` is true. A bundle that says anything else is refused
 *     rather than rendered — peer material that lost its trust label would be
 *     read as an instruction.
 *   * `budget.usedBytes` equals the encoded length. That is what makes the
 *     stored digest checkable without re-deriving the whole thing.
 *   * The identities in the bundle equal the identities in the row. A receipt
 *     that could be re-pointed at another session would stop being evidence.
 */

export interface Sections {
  readonly goal: string;
  readonly constraints: string;
  readonly completed: string;
  readonly pending: string;
  readonly decisions: string;
  readonly toolSummary: string;
}

export const EMPTY_SECTIONS: Sections = {
  goal: "",
  constraints: "",
  completed: "",
  pending: "",
  decisions: "",
  toolSummary: "",
};

/** The section names, in the order the budget gives them up. */
export const SECTION_KEYS = [
  "goal",
  "constraints",
  "pending",
  "completed",
  "decisions",
  "toolSummary",
] as const;

export interface Identity {
  readonly nodeId: string;
  readonly nodeTitle: string;
  readonly sessionId: string;
  readonly generation: number;
  readonly agentId: string;
  readonly provider: string;
  readonly providerSessionId: string | null;
  readonly modelId: string | null;
  readonly accountId: string | null;
  readonly executionHost: string;
  readonly workingDirectory: string;
}

export interface Cutoff {
  readonly kind: string;
  readonly reference: string | null;
  readonly sourceRevision: string | null;
  readonly sha256: string | null;
  readonly sourceUpdatedAt: string | null;
}

export interface FileReference {
  readonly path: string;
  readonly sha256: string | null;
  readonly bytes: number | null;
  readonly status: string;
  readonly executionHost: string;
}

export interface GitFingerprint {
  readonly headOid: string | null;
  readonly indexDigest: string | null;
  readonly worktreeDigest: string | null;
  readonly repositoryId: string | null;
  readonly worktreeId: string | null;
  readonly status: string;
  readonly worktreeDigestBasis: string;
}

export interface Budget {
  readonly byteLimit: number;
  readonly usedBytes: number;
  readonly tokenEstimate: number | null;
  readonly capacityTokens: number | null;
  readonly availableTokens: number | null;
  readonly reservedTokens: number | null;
  readonly truncated: boolean;
  readonly omitted: readonly string[];
}

export interface HandoffBundle {
  readonly version: number;
  readonly handoffId: string;
  readonly workspaceId: string;
  readonly createdAt: string;
  readonly source: Identity;
  readonly target: Identity;
  readonly cutoff: Cutoff;
  readonly sections: Sections;
  readonly transcriptExcerpt: string;
  readonly summaryMethod: string;
  readonly trust: string;
  readonly sourcePreserved: boolean;
  readonly files: readonly FileReference[];
  readonly git: GitFingerprint;
  readonly attachments: readonly unknown[];
  readonly budget: Budget;
}

export const TRUST = "peerDataNotSystemInstructions";
export const BYTE_BUDGETS = [8192, 16384, 32768] as const;

/** The largest a single referenced file may be before it is only named. */
const MAX_FILE_BYTES = 8 * 1024 * 1024;

export function digest(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/* -------------------------------- sanitizing ------------------------------- */

const SECRET_PATTERNS: readonly RegExp[] = [
  // Bearer tokens and the common provider key prefixes. Deliberately narrow:
  // a pattern that matched too much would redact the code the peer needs.
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/g,
  /\bghp_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\b[Bb]earer\s+[A-Za-z0-9._~+/-]{20,}=*/g,
];

/**
 * Removes control characters, redacts what looks like a credential, and drops
 * private-key blocks whole.
 *
 * A key block is dropped rather than redacted line by line because the middle
 * of a PEM body matches nothing: a per-line redactor would keep every byte of
 * the key and remove only the header.
 */
export function sanitize(text: string): string {
  const plain = [...text.replace(/\r\n?/g, "\n")]
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0;
      return character === "\n" || character === "\t" || code >= 0x20;
    })
    .join("");
  const lines: string[] = [];
  let inKey = false;
  for (const line of plain.split("\n")) {
    if (line.includes("-----BEGIN") && line.includes("PRIVATE KEY-----")) {
      inKey = true;
      lines.push("[PRIVATE KEY REDACTED]");
      continue;
    }
    if (inKey) {
      if (line.includes("-----END") && line.includes("PRIVATE KEY-----")) {
        inKey = false;
      }
      continue;
    }
    lines.push(redactSecrets(line));
  }
  return lines.join("\n");
}

export function redactSecrets(line: string): string {
  let out = line;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, "[REDACTED]");
  }
  return out;
}

/** Paths whose contents are never fingerprinted, whatever the caller asked. */
export function sensitive(path: string): boolean {
  return path
    .replace(/\\/g, "/")
    .split("/")
    .some((raw) => {
      const part = raw.toLowerCase();
      if (part.startsWith(".env")) return true;
      if (
        [
          ".ssh",
          ".aws",
          ".gnupg",
          "credentials",
          "credentials.json",
          "id_rsa",
          "id_ed25519",
          ".npmrc",
          ".netrc",
        ].includes(part)
      ) {
        return true;
      }
      return [".pem", ".key", ".p12", ".pfx", ".keystore"].some((suffix) =>
        part.endsWith(suffix),
      );
    });
}

/**
 * Hashes the files the user selected, or says why it could not.
 *
 * Every outcome is a *status*, never a silent omission: `excluded` is a path
 * this build refuses to read, `missing` is one that is not there, `changed` is
 * one that moved while being read, and only `referenced` carries a digest. A
 * reference is a live file, not a copy — which is exactly why the digest
 * matters.
 */
export function fingerprintFiles(
  root: string,
  paths: readonly string[],
): FileReference[] {
  const files: FileReference[] = [];
  for (const path of paths) {
    if (files.some((file) => file.path === path)) continue;
    const base = {
      path: sanitize(path),
      sha256: null,
      bytes: null,
      executionHost: "local-runtime",
    };
    if (
      sensitive(path) ||
      isAbsolute(path) ||
      [...path].some((character) => (character.codePointAt(0) ?? 0) < 0x20)
    ) {
      files.push({ ...base, status: "excluded" });
      continue;
    }
    let resolved: string;
    try {
      resolved = resolveInRoot(root, path);
    } catch {
      files.push({ ...base, status: "missing" });
      continue;
    }
    let before;
    try {
      before = statSync(resolved);
    } catch {
      files.push({ ...base, status: "missing" });
      continue;
    }
    if (!before.isFile() || before.size > MAX_FILE_BYTES) {
      files.push({ ...base, status: "excluded" });
      continue;
    }
    let bytes: Buffer;
    try {
      bytes = readFileSync(resolved);
    } catch {
      files.push({ ...base, status: "missing" });
      continue;
    }
    const after = statSync(resolved);
    if (
      bytes.byteLength !== before.size ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs
    ) {
      files.push({ ...base, status: "changed" });
      continue;
    }
    files.push({
      ...base,
      status: "referenced",
      sha256: digest(bytes),
      bytes: bytes.byteLength,
    });
  }
  return files;
}

/* ---------------------------------- budget --------------------------------- */

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

export class BudgetExceeded extends Error {}

function encodedSize(bundle: HandoffBundle): number {
  // The length is itself a field of the thing being measured, so the encoding
  // is iterated to a fixed point rather than computed once. Six passes is
  // enough for any decimal width the limit allows.
  let working = bundle as Mutable<HandoffBundle>;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const size = Buffer.byteLength(JSON.stringify(working), "utf8");
    if (size === working.budget.usedBytes) return size;
    working.budget = { ...working.budget, usedBytes: size };
  }
  return Buffer.byteLength(JSON.stringify(working), "utf8");
}

/**
 * Cuts the bundle down to its byte budget, longest-lived material last.
 *
 * The order is the user's priority, not ours: the transcript excerpt is
 * evidence and goes first, then the tool summary, the decisions, the completed
 * and pending work, the constraints, and only then the goal. A bundle whose
 * *goal* would not fit is refused outright — a handoff that cannot say what it
 * is for is not a shorter handoff, it is a different one.
 */
export function fitBudget(bundle: HandoffBundle): HandoffBundle {
  const working = structuredClone(bundle) as Mutable<HandoffBundle>;
  const originals: [keyof Sections | "transcript", string][] = [
    ...SECTION_KEYS.map(
      (key) => [key, bundle.sections[key]] as [keyof Sections, string],
    ),
    ["transcript", bundle.transcriptExcerpt],
  ];
  working.sections = { ...EMPTY_SECTIONS };
  working.transcriptExcerpt = "";
  // A placeholder of the final width, so measuring the empty bundle measures
  // the shape the full one will have.
  working.cutoff = { ...working.cutoff, sha256: "0".repeat(64) };
  const omitted = [...working.budget.omitted];
  if (encodedSize(working) > working.budget.byteLimit) {
    throw new BudgetExceeded(
      "Selected metadata exceeds the byte budget; choose fewer file references",
    );
  }

  let truncated = working.budget.truncated;
  for (const [name, original] of originals) {
    const value = sanitize(original);
    if (value !== original) omitted.push(`sanitized:${name}`);
    const characters = [...value];
    let low = 0;
    let high = characters.length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      setSection(working, name, characters.slice(0, middle).join(""));
      if (encodedSize(working) <= working.budget.byteLimit) low = middle;
      else high = middle - 1;
    }
    setSection(working, name, characters.slice(0, low).join(""));
    if (low < characters.length) {
      truncated = true;
      omitted.push(`truncated:${name}`);
    }
  }

  working.budget = { ...working.budget, truncated, omitted };
  working.cutoff = {
    ...working.cutoff,
    sha256:
      working.transcriptExcerpt === ""
        ? null
        : digest(working.transcriptExcerpt),
  };
  // Truncation notices themselves consume bytes. Trim evidence first while
  // keeping the user's highest-priority goal, then fail if metadata cannot fit.
  while (encodedSize(working) > working.budget.byteLimit) {
    if (!popOneCharacter(working)) {
      throw new BudgetExceeded("Handoff metadata exceeds byte budget");
    }
    working.budget = { ...working.budget, truncated: true };
  }
  if (working.sections.goal === "") {
    throw new BudgetExceeded("The goal does not fit this byte budget");
  }
  working.cutoff = {
    ...working.cutoff,
    sha256:
      working.transcriptExcerpt === ""
        ? null
        : digest(working.transcriptExcerpt),
  };
  encodedSize(working);
  return working;
}

function setSection(
  bundle: Mutable<HandoffBundle>,
  name: keyof Sections | "transcript",
  value: string,
): void {
  if (name === "transcript") {
    bundle.transcriptExcerpt = value;
    return;
  }
  bundle.sections = { ...bundle.sections, [name]: value };
}

function popOneCharacter(bundle: Mutable<HandoffBundle>): boolean {
  const order: (keyof Sections | "transcript")[] = [
    "transcript",
    "toolSummary",
    "decisions",
    "completed",
    "pending",
    "constraints",
    "goal",
  ];
  for (const name of order) {
    const current =
      name === "transcript" ? bundle.transcriptExcerpt : bundle.sections[name];
    if (current === "") continue;
    const characters = [...current];
    characters.pop();
    setSection(bundle, name, characters.join(""));
    return true;
  }
  return false;
}
