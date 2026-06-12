/**
 * Pure helpers shared by the node bodies. Everything here is deterministic and
 * covered by `helpers.test.ts` — the components stay free of parsing logic.
 */

export type PatchSign = "+" | "-" | " ";

export interface PatchLine {
  /** Line number shown in the gutter (new file for `+`/context, old for `-`). */
  no: string;
  sign: PatchSign;
  text: string;
}

export interface PatchHunk {
  /** The raw `@@ … @@` header line. */
  header: string;
  lines: PatchLine[];
}

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/**
 * Whether a `gitDiff` patch is a real unified diff. The runtime substitutes a
 * human-readable placeholder (e.g. `(未预览：…)`) for binary or oversized
 * untracked files, and such text must never reach a `.patch` export.
 */
export function hasHunks(patch: string): boolean {
  return patch.split("\n").some((line) => HUNK_HEADER.test(line));
}

/**
 * Splits a unified diff into hunks with per-line numbers. Anything before the
 * first `@@` (the `diff --git` / `+++` preamble) is dropped, and `\ No newline`
 * markers are ignored.
 */
export function parsePatch(patch: string): PatchHunk[] {
  const hunks: PatchHunk[] = [];
  let current: PatchHunk | null = null;
  let oldNo = 0;
  let newNo = 0;

  for (const raw of patch.split("\n")) {
    const match = HUNK_HEADER.exec(raw);
    if (match) {
      current = { header: raw, lines: [] };
      hunks.push(current);
      oldNo = Number.parseInt(match[1]!, 10);
      newNo = Number.parseInt(match[2]!, 10);
      continue;
    }
    if (!current) continue;
    if (raw.startsWith("\\")) continue;
    if (raw.startsWith("+")) {
      current.lines.push({
        no: String(newNo++),
        sign: "+",
        text: raw.slice(1),
      });
    } else if (raw.startsWith("-")) {
      current.lines.push({
        no: String(oldNo++),
        sign: "-",
        text: raw.slice(1),
      });
    } else if (raw.startsWith(" ")) {
      // Git always writes a leading space for context lines, so a bare empty
      // string is only the trailing newline of the patch.
      current.lines.push({ no: String(newNo), sign: " ", text: raw.slice(1) });
      oldNo += 1;
      newNo += 1;
    }
  }
  return hunks;
}

/**
 * Title for a Browser node: the hostname, or a fallback when the address is
 * not a parseable absolute URL yet.
 */
export function hostnameTitle(url: string, fallback: string): string {
  const trimmed = url.trim();
  if (!trimmed || trimmed === "https://" || trimmed === "http://")
    return fallback;
  try {
    const parsed = new URL(
      /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`,
    );
    return parsed.hostname || fallback;
  } catch {
    return fallback;
  }
}

/** Normalises what the user typed in the address bar into a navigable URL. */
export function normalizeUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return "";
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

/**
 * Very rough prompt-size estimate: ~4 bytes per token. Always presented as
 * "估算" in the UI because no tokenizer runs locally (plan §7 rule 4).
 */
export function estimateTokens(totalBytes: number): number {
  if (!Number.isFinite(totalBytes) || totalBytes <= 0) return 0;
  return Math.round(totalBytes / 4);
}

/** `12480` → `12.4k`, `840` → `840`. */
export function formatTokens(total: number): string {
  if (total < 1000) return String(total);
  return `${(total / 1000).toFixed(1)}k`;
}

/** Seconds → `m:ss` (the `◷` counter in the Agent header). */
export function formatElapsed(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  return `${Math.floor(safe / 60)}:${String(safe % 60).padStart(2, "0")}`;
}

const LANGUAGES: Record<string, string> = {
  ts: "TypeScript",
  tsx: "TypeScript React",
  js: "JavaScript",
  jsx: "JavaScript React",
  rs: "Rust",
  py: "Python",
  go: "Go",
  java: "Java",
  kt: "Kotlin",
  swift: "Swift",
  c: "C",
  h: "C",
  cc: "C++",
  cpp: "C++",
  hpp: "C++",
  cs: "C#",
  rb: "Ruby",
  php: "PHP",
  sh: "Shell",
  zsh: "Shell",
  bash: "Shell",
  sql: "SQL",
  json: "JSON",
  yml: "YAML",
  yaml: "YAML",
  toml: "TOML",
  css: "CSS",
  scss: "SCSS",
  html: "HTML",
  md: "Markdown",
  vue: "Vue",
  svelte: "Svelte",
};

/** Best-effort language label for the File node subtitle. */
export function guessLanguage(path: string): string | undefined {
  const name = path.split("/").pop() ?? path;
  const extension = name.includes(".")
    ? name.split(".").pop()!.toLowerCase()
    : "";
  return LANGUAGES[extension];
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

/** `HH:MM:SS` for log rows; invalid timestamps degrade to `--:--:--`. */
export function formatClock(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "--:--:--";
  return [date.getHours(), date.getMinutes(), date.getSeconds()]
    .map((part) => String(part).padStart(2, "0"))
    .join(":");
}
