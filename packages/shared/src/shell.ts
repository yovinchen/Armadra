/**
 * Writing one word of a line *typed into a shell*, per shell dialect.
 *
 * A launch line is not exec'd: it is typed into the node's terminal, so how a
 * value survives depends on which shell reads it. The node's shell is whatever
 * the terminal runs — `$SHELL` on macOS and Linux, `COMSPEC` (`cmd.exe`) on
 * Windows unless the node names another — so every writer of a launch line
 * asks {@link shellDialect} first and quotes with the answer. One set of rules,
 * used by the page (`apps/web/src/agent/launch.ts`) and the core
 * (`agent/canvas-launch.ts`) alike.
 *
 * The file exists twice, byte for byte: `packages/shared/src/shell.ts` for the
 * page and `apps/desktop/src/core/terminal/shell.ts` for the core, which does
 * not depend on `@armadra/shared`. A core test fails when the two differ.
 *
 * Four dialects, because four sets of rules differ:
 *
 *   * `posix` — sh, bash, zsh, dash, ksh: single quotes are fully literal.
 *   * `fish` — single quotes are *not* fully literal: `\\` and `\'` are
 *     escapes inside them, so a value ending in a backslash would swallow the
 *     closing quote. `%` at the start of a word was process expansion.
 *   * `cmd` — no quote removal of its own: the text after the program goes to
 *     the child as it is, which splits it with the Windows C runtime rules
 *     (`"` groups, `\"` is a literal quote). `%NAME%` is expanded before
 *     anything else, even inside quotes, and `& | < > ^ ( )` are live outside
 *     quotes. `^` escapes one character.
 *   * `powershell` — Windows PowerShell and PowerShell 7 (`pwsh`): single
 *     quotes are literal with `''` for a quote (the typographic single quotes
 *     count too), a quoted program needs the call operator `&`, and variables
 *     are `$env:NAME`. How the argument then reaches a native program is
 *     PowerShell 7.3+'s: an embedded `"` arrives intact. Windows PowerShell 5.1
 *     passes it unescaped and the program sees it stripped — a limit of that
 *     shell, not of the quoting.
 */

export type ShellDialect = "posix" | "fish" | "cmd" | "powershell";

/**
 * A word of a launch line before it is quoted: a literal value, or a value the
 * shell reads from an environment variable of the node's terminal, after a
 * literal prefix (`-c "hooks.Stop=$VAR"`). The second form keeps a long value
 * off the typed line; the environment is the terminal's own.
 */
export type LaunchWord =
  | string
  | { readonly prefix: string; readonly env: string };

/** `C:\Windows\System32\cmd.exe` → `cmd`; `/usr/local/bin/fish` → `fish`. */
export function shellProgramName(shell: string): string {
  return (
    shell
      .trim()
      .replace(/\\/g, "/")
      .split("/")
      .at(-1)
      ?.toLowerCase()
      .replace(/\.exe$/, "") ?? ""
  );
}

/**
 * The dialect of a shell program. A name this does not know is read as POSIX:
 * that is what every other shell a terminal is likely to run understands.
 */
export function shellDialect(shell: string | undefined): ShellDialect {
  switch (shellProgramName(shell ?? "")) {
    case "fish":
      return "fish";
    case "cmd":
      return "cmd";
    case "powershell":
    case "pwsh":
    case "pwsh-preview":
      return "powershell";
    default:
      return "posix";
  }
}

const POSIX_SAFE = /^[A-Za-z0-9_@%+=:,./-]+$/;
const FISH_SAFE = /^[A-Za-z0-9_@+=:,./-]+$/;
/** `\` and `~` (8.3 names) are ordinary to `cmd.exe`; a path goes as it is. */
const CMD_SAFE = /^[A-Za-z0-9_@+=:,./\\~-]+$/;
const POWERSHELL_SAFE = /^[A-Za-z0-9_+=:./\\-]+$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** What `cmd.exe` acts on outside quotes; each is escaped with `^`. */
const CMD_META = /[()%!^"<>&|]/g;
const LINE_BREAK = /[\r\n]/;

/** POSIX single quotes: `it's` → `'it'\''s'`, only when the word needs them. */
export function posixQuote(value: string): string {
  if (value.length > 0 && POSIX_SAFE.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function fishQuote(value: string): string {
  if (value.length > 0 && FISH_SAFE.test(value)) return value;
  return `'${value.replace(/[\\']/g, "\\$&")}'`;
}

/**
 * The Windows C runtime's quoting: `"` becomes `\"`, and the backslashes
 * directly in front of a quote — the closing one included — are doubled.
 */
function argvQuote(value: string): string {
  const body = value
    .replace(/(\\*)"/g, (_, slashes: string) => `${slashes}${slashes}\\"`)
    .replace(/(\\+)$/, "$1$1");
  return `"${body}"`;
}

function cmdQuote(value: string): string {
  if (LINE_BREAK.test(value)) {
    throw new Error("cmd.exe cannot take a line break inside an argument");
  }
  if (value.length > 0 && CMD_SAFE.test(value)) return value;
  // Inside `"…"` cmd.exe leaves `& | < > ^ ( )` alone; `%` and `!` it would
  // still expand, and a `"` would end the quoting.
  if (!/[%!"]/.test(value)) return argvQuote(value);
  // Otherwise every quote is escaped too, so cmd.exe is never inside quotes
  // and each live character carries its own `^`. `^%` also breaks a
  // `%NAME%` apart: the name becomes `NAME^`, which is not set, and the
  // caret is dropped after expansion.
  return argvQuote(value).replace(CMD_META, "^$&");
}

function powershellQuote(value: string): string {
  if (value.length > 0 && value !== "--" && POWERSHELL_SAFE.test(value)) {
    return value;
  }
  return `'${value.replace(/['\u2018\u2019\u201a\u201b]/g, "$&$&")}'`;
}

/** One literal value as a word the shell hands to the program unchanged. */
export function quoteShellWord(value: string, dialect: ShellDialect): string {
  switch (dialect) {
    case "posix":
      return posixQuote(value);
    case "fish":
      return fishQuote(value);
    case "cmd":
      return cmdQuote(value);
    case "powershell":
      return powershellQuote(value);
  }
}

/**
 * `prefix` followed by the value of the environment variable `name`, as one
 * word — double quotes in every dialect, so the value is never split:
 * `"p$NAME"` / `"p%NAME%"` / `"p${env:NAME}"`.
 *
 * `cmd.exe` pastes the value's text into those quotes before it reads the
 * line, so there the *value* must hold no `"` and not end in `\` (which would
 * escape the closing quote for the program). The environment is ours, so it is
 * written for that — see the core's `codexTomlString`.
 */
export function shellEnvWord(
  prefix: string,
  name: string,
  dialect: ShellDialect,
): string {
  if (!ENV_NAME.test(name)) {
    throw new Error(`Not an environment variable name: ${name}`);
  }
  if (LINE_BREAK.test(prefix)) {
    throw new Error("A line break cannot be typed inside a word");
  }
  switch (dialect) {
    case "posix":
      // `!` is history expansion inside double quotes in bash and zsh.
      if (prefix.includes("!")) {
        throw new Error("`!` cannot be typed inside double quotes");
      }
      return `"${prefix.replace(/[\\$`"]/g, "\\$&")}\${${name}}"`;
    case "fish":
      return `"${prefix.replace(/[\\$"]/g, "\\$&")}$${name}"`;
    case "cmd":
      if (/[%!"]/.test(prefix)) {
        throw new Error("cmd.exe would expand or unquote this prefix");
      }
      return `"${prefix}%${name}%"`;
    case "powershell":
      return `"${prefix.replace(/[`$"\u201c\u201d\u201e]/g, "`$&")}\${env:${name}}"`;
  }
}

/** A {@link LaunchWord} as typed text. */
export function renderLaunchWord(
  word: LaunchWord,
  dialect: ShellDialect,
): string {
  return typeof word === "string"
    ? quoteShellWord(word, dialect)
    : shellEnvWord(word.prefix, word.env, dialect);
}

/**
 * A whole command line: the program, then the words. PowerShell reads a
 * quoted first word as a string to print, so a quoted program there takes
 * the call operator.
 */
export function shellCommandLine(
  program: string,
  words: readonly LaunchWord[],
  dialect: ShellDialect,
): string {
  let head = quoteShellWord(program, dialect);
  if (dialect === "powershell" && head !== program) head = `& ${head}`;
  return [head, ...words.map((word) => renderLaunchWord(word, dialect))].join(
    " ",
  );
}
