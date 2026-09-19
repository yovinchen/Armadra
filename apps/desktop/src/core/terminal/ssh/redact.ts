/**
 * `redact_secrets`, ported from `apps/runtime/src/security.rs`.
 *
 * Two things in this domain are written by somebody other than Armadra and are
 * then shown to a person: a server's prompt text, and `ssh`'s own diagnostics.
 * Either can contain a secret — a prompt is a string the far side chose, and a
 * verbose `ssh` log can quote a configuration line — so both go through here
 * before they reach a client, an event or a log.
 *
 * It lives beside the SSH code rather than in a shared `core/security` module
 * because no such module exists yet. When one lands (R3 needs the same
 * function for hook payloads) this moves there unchanged; the regular
 * expressions are the contract, not the file name.
 */

/**
 * `NAME=value` / `NAME: value` for the names that are always secrets. The
 * value runs to the first whitespace, comma or semicolon, the way the Rust
 * character class `[^\s,;]+` does.
 */
const ASSIGNMENTS =
  /(OPENAI_API_KEY|ANTHROPIC_API_KEY|GEMINI_API_KEY|password|token|secret)\s*[:=]\s*([^\s,;]+)/giu;

const BEARER = /(Authorization\s*:\s*Bearer\s+)(\S+)/giu;

export function redactSecrets(input: string): string {
  // `$1=[REDACTED]` — the separator is normalised to `=` exactly as the Rust
  // replacement template does, so a redacted line reads the same on both
  // implementations and the tests can be compared literally.
  return input
    .replace(ASSIGNMENTS, "$1=[REDACTED]")
    .replace(BEARER, "$1[REDACTED]");
}

/** How many trailing lines of diagnostics the UI is shown. */
const OUTPUT_LINES = 6;
const OUTPUT_CHARS = 600;

/**
 * The redacted tail of whatever `ssh` said.
 *
 * Never a full transcript: a verbose `ssh` runs to hundreds of lines, and the
 * settings page shows this in a box beside a button. Ported from `ssh::tail`
 * in `apps/runtime/src/terminal/ssh/mod.rs`, including its character ceiling
 * being counted in code points rather than in UTF-16 units.
 */
export function tail(text: string): string {
  const lines = text.split("\n").filter((line) => line.trim() !== "");
  const joined = lines
    .slice(Math.max(0, lines.length - OUTPUT_LINES))
    .join("\n");
  const redacted = redactSecrets(joined);
  return [...redacted].slice(0, OUTPUT_CHARS).join("");
}
