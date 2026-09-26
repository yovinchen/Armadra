import { describe, expect, it } from "vitest";

import {
  type ShimProbe,
  type ShimTarget,
  parseCmdShim,
  parsePs1Shim,
  shimTarget,
} from "./windows-shim";

/**
 * npm / pnpm 在 Windows 上写的包装脚本，逐个样本读出背后的程序。
 *
 * 样本照各生成器的输出逐字写（CRLF 行尾、变量名、空格数都照原样）：npm 7–10
 * 的 cmd-shim（node 脚本与原生程序两种目标、带 shebang 参数）、npm 6 的
 * `IF EXIST … ELSE` 块、pnpm 的带 `NODE_PATH` 的块，以及它们一起写的 `.ps1`。
 * 文件系统是假的：Windows 路径在 macOS 与 Linux 上照样能测。
 */

const BIN = "C:\\Users\\me\\AppData\\Roaming\\npm";
const NODE = "C:\\Program Files\\nodejs\\node.exe";
const CODEX_JS = `${BIN}\\node_modules\\@openai\\codex\\bin\\codex.js`;
const CLAUDE_EXE = `${BIN}\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe`;
const PNPM = "C:\\Users\\me\\AppData\\Local\\pnpm";
const PNPM_CLI = `${PNPM}\\global\\5\\node_modules\\@anthropic-ai\\claude-code\\cli.js`;

const crlf = (lines: readonly string[]): string => `${lines.join("\r\n")}\r\n`;

const CMD_SHIM_HEAD = [
  "@ECHO off",
  "GOTO start",
  ":find_dp0",
  "SET dp0=%~dp0",
  "EXIT /b",
  ":start",
  "SETLOCAL",
  "CALL :find_dp0",
];

/** npm 7–10：目标是 node 脚本（`#!/usr/bin/env node`）。 */
function npmNodeShim(target: string, shebangArgs = ""): string {
  return crlf([
    ...CMD_SHIM_HEAD,
    "",
    'IF EXIST "%dp0%\\node.exe" (',
    '  SET "_prog=%dp0%\\node.exe"',
    ") ELSE (",
    '  SET "_prog=node"',
    "  SET PATHEXT=%PATHEXT:;.JS;=;%",
    ")",
    "",
    `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%" ${shebangArgs} "%dp0%\\${target}" %*`,
  ]);
}

/** npm 7–10：目标没有 shebang（包里带的原生程序）。 */
function npmNativeShim(target: string): string {
  return crlf([...CMD_SHIM_HEAD, `"%dp0%\\${target}"   %*`]);
}

/** npm 6（cmd-shim 3）。 */
function npm6Shim(target: string): string {
  return crlf([
    '@IF EXIST "%~dp0\\node.exe" (',
    `  "%~dp0\\node.exe"  "%~dp0\\${target}" %*`,
    ") ELSE (",
    "  @SETLOCAL",
    "  @SET PATHEXT=%PATHEXT:;.JS;=;%",
    `  node  "%~dp0\\${target}" %*`,
    ")",
  ]);
}

/** pnpm（@zkochan/cmd-shim）：多一段 `NODE_PATH`。 */
function pnpmShim(target: string): string {
  const store = `${PNPM}\\global\\5\\node_modules\\.pnpm\\node_modules`;
  return crlf([
    "@SETLOCAL",
    "@IF NOT DEFINED NODE_PATH (",
    `  @SET "NODE_PATH=${store}"`,
    ") ELSE (",
    `  @SET "NODE_PATH=${store};%NODE_PATH%"`,
    ")",
    '@IF EXIST "%~dp0\\node.exe" (',
    `  "%~dp0\\node.exe"  "%~dp0\\${target}" %*`,
    ") ELSE (",
    "  @SET PATHEXT=%PATHEXT:;.JS;=;%",
    `  node  "%~dp0\\${target}" %*`,
    ")",
  ]);
}

/** npm 与 pnpm 一起写的 `.ps1`，目标是 node 脚本。 */
function ps1NodeShim(target: string): string {
  return crlf([
    "#!/usr/bin/env pwsh",
    "$basedir=Split-Path $MyInvocation.MyCommand.Definition -Parent",
    "",
    '$exe=""',
    'if ($PSVersionTable.PSVersion -lt "6.0" -or $IsWindows) {',
    "  # Fix case when both the Windows and Linux builds of Node",
    "  # are installed in the same directory",
    '  $exe=".exe"',
    "}",
    "$ret=0",
    'if (Test-Path "$basedir/node$exe") {',
    "  # Support pipeline input",
    "  if ($MyInvocation.ExpectingInput) {",
    `    $input | & "$basedir/node$exe"  "$basedir/${target}" $args`,
    "  } else {",
    `    & "$basedir/node$exe"  "$basedir/${target}" $args`,
    "  }",
    "  $ret=$LASTEXITCODE",
    "} else {",
    "  # Support pipeline input",
    "  if ($MyInvocation.ExpectingInput) {",
    `    $input | & "node$exe"  "$basedir/${target}" $args`,
    "  } else {",
    `    & "node$exe"  "$basedir/${target}" $args`,
    "  }",
    "  $ret=$LASTEXITCODE",
    "}",
    "exit $ret",
  ]);
}

function ps1NativeShim(target: string): string {
  return crlf([
    "#!/usr/bin/env pwsh",
    "$basedir=Split-Path $MyInvocation.MyCommand.Definition -Parent",
    "",
    '$exe=""',
    'if ($PSVersionTable.PSVersion -lt "6.0" -or $IsWindows) {',
    '  $exe=".exe"',
    "}",
    `& "$basedir/${target}"   $args`,
    "exit $LASTEXITCODE",
  ]);
}

function probe(
  files: readonly string[],
  texts: Readonly<Record<string, string>> = {},
): ShimProbe {
  const lower = new Set(files.map((file) => file.toLowerCase()));
  return {
    isFile: (path) => lower.has(path.toLowerCase()),
    read: (path) => texts[path],
    which: (name) => (name === "node" ? NODE : undefined),
  };
}

interface Sample {
  readonly name: string;
  readonly kind: "cmd" | "ps1";
  readonly shim: string;
  readonly text: string;
  readonly files: readonly string[];
  readonly expected: ShimTarget | undefined;
}

const SAMPLES: readonly Sample[] = [
  {
    name: "npm 7–10，node 脚本，用 PATH 上的 node",
    kind: "cmd",
    shim: `${BIN}\\codex.cmd`,
    text: npmNodeShim("node_modules\\@openai\\codex\\bin\\codex.js"),
    files: [CODEX_JS],
    expected: { program: NODE, args: [CODEX_JS] },
  },
  {
    name: "npm 7–10，包旁边有 node.exe 时用它",
    kind: "cmd",
    shim: `${BIN}\\codex.cmd`,
    text: npmNodeShim("node_modules\\@openai\\codex\\bin\\codex.js"),
    files: [CODEX_JS, `${BIN}\\node.exe`],
    expected: { program: `${BIN}\\node.exe`, args: [CODEX_JS] },
  },
  {
    name: "npm 7–10，shebang 带参数",
    kind: "cmd",
    shim: `${BIN}\\codex.cmd`,
    text: npmNodeShim(
      "node_modules\\@openai\\codex\\bin\\codex.js",
      "--no-warnings",
    ),
    files: [CODEX_JS],
    expected: { program: NODE, args: ["--no-warnings", CODEX_JS] },
  },
  {
    name: "npm 7–10，包里带的原生程序",
    kind: "cmd",
    shim: `${BIN}\\claude.cmd`,
    text: npmNativeShim(
      "node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe",
    ),
    files: [CLAUDE_EXE],
    expected: { program: CLAUDE_EXE, args: [] },
  },
  {
    name: "npm 6，没有自带 node.exe",
    kind: "cmd",
    shim: `${BIN}\\codex.cmd`,
    text: npm6Shim("node_modules\\@openai\\codex\\bin\\codex.js"),
    files: [CODEX_JS],
    expected: { program: NODE, args: [CODEX_JS] },
  },
  {
    name: "npm 6，自带 node.exe",
    kind: "cmd",
    shim: `${BIN}\\codex.cmd`,
    text: npm6Shim("node_modules\\@openai\\codex\\bin\\codex.js"),
    files: [CODEX_JS, `${BIN}\\node.exe`],
    expected: { program: `${BIN}\\node.exe`, args: [CODEX_JS] },
  },
  {
    name: "pnpm，全局目录下的包",
    kind: "cmd",
    shim: `${PNPM}\\claude.cmd`,
    text: pnpmShim(
      "global\\5\\node_modules\\@anthropic-ai\\claude-code\\cli.js",
    ),
    files: [PNPM_CLI],
    expected: { program: NODE, args: [PNPM_CLI] },
  },
  {
    name: "pnpm，目标里带 ..",
    kind: "cmd",
    shim: `${PNPM}\\bin\\claude.cmd`,
    text: pnpmShim(
      "..\\global\\5\\node_modules\\@anthropic-ai\\claude-code\\cli.js",
    ),
    files: [PNPM_CLI],
    expected: { program: NODE, args: [PNPM_CLI] },
  },
  {
    name: ".ps1，node 脚本",
    kind: "ps1",
    shim: `${BIN}\\codex.ps1`,
    text: ps1NodeShim("node_modules/@openai/codex/bin/codex.js"),
    files: [CODEX_JS],
    expected: { program: NODE, args: [CODEX_JS] },
  },
  {
    name: ".ps1，自带 node.exe",
    kind: "ps1",
    shim: `${BIN}\\codex.ps1`,
    text: ps1NodeShim("node_modules/@openai/codex/bin/codex.js"),
    files: [CODEX_JS, `${BIN}\\node.exe`],
    expected: { program: `${BIN}\\node.exe`, args: [CODEX_JS] },
  },
  {
    name: ".ps1，原生程序",
    kind: "ps1",
    shim: `${BIN}\\claude.ps1`,
    text: ps1NativeShim(
      "node_modules/@anthropic-ai/claude-code/bin/claude.exe",
    ),
    files: [CLAUDE_EXE],
    expected: { program: CLAUDE_EXE, args: [] },
  },
  {
    name: "脚本不在了：读不出来",
    kind: "cmd",
    shim: `${BIN}\\codex.cmd`,
    text: npmNodeShim("node_modules\\@openai\\codex\\bin\\codex.js"),
    files: [],
    expected: undefined,
  },
  {
    name: "手写的批处理：程序是个变量",
    kind: "cmd",
    shim: `${BIN}\\mine.cmd`,
    text: crlf([
      "@echo off",
      'set "PROG=C:\\tools\\mine.exe"',
      '"%PROG%" --flag %*',
    ]),
    files: ["C:\\tools\\mine.exe"],
    expected: undefined,
  },
  {
    name: "手写的批处理：先 call 别的批处理",
    kind: "cmd",
    shim: `${BIN}\\mine.cmd`,
    text: crlf(["@echo off", 'call "C:\\tools\\real.bat" %*']),
    files: ["C:\\tools\\real.bat"],
    expected: undefined,
  },
  {
    name: "只有一个词、又不是 .exe：不猜它怎么跑",
    kind: "cmd",
    shim: `${BIN}\\mine.cmd`,
    text: crlf([...CMD_SHIM_HEAD, '"%dp0%\\node_modules\\mine\\cli.js"   %*']),
    files: [`${BIN}\\node_modules\\mine\\cli.js`],
    expected: undefined,
  },
];

describe("npm / pnpm 包装脚本", () => {
  it.each(SAMPLES)("$name", (sample) => {
    const parse = sample.kind === "cmd" ? parseCmdShim : parsePs1Shim;
    expect(parse(sample.text, sample.shim, probe(sample.files))).toEqual(
      sample.expected,
    );
  });

  it("按扩展名分派，不是包装的路径不读", () => {
    const shim = `${BIN}\\codex.cmd`;
    const files = [CODEX_JS, shim];
    const texts = {
      [shim]: npmNodeShim("node_modules\\@openai\\codex\\bin\\codex.js"),
    };
    expect(shimTarget(shim, probe(files, texts))).toEqual({
      program: NODE,
      args: [CODEX_JS],
    });
    expect(shimTarget(CLAUDE_EXE, probe([CLAUDE_EXE]))).toBeUndefined();
    expect(shimTarget("/usr/local/bin/claude", probe([]))).toBeUndefined();
  });

  it(".cmd 读不出来时试同名的 .ps1", () => {
    const shim = `${BIN}\\codex.cmd`;
    const ps1 = `${BIN}\\codex.ps1`;
    const texts = {
      [shim]: crlf(["@echo off", 'set "P=x"', '"%P%" %*']),
      [ps1]: ps1NodeShim("node_modules/@openai/codex/bin/codex.js"),
    };
    expect(shimTarget(shim, probe([CODEX_JS, shim, ps1], texts))).toEqual({
      program: NODE,
      args: [CODEX_JS],
    });
    // 两份都读不出来：调用方照旧用 .cmd。
    expect(
      shimTarget(shim, probe([shim], { [shim]: texts[shim] as string })),
    ).toBeUndefined();
  });

  it("PATH 上没有 node 时不答", () => {
    const text = npmNodeShim("node_modules\\@openai\\codex\\bin\\codex.js");
    expect(
      parseCmdShim(text, `${BIN}\\codex.cmd`, {
        ...probe([CODEX_JS]),
        which: () => undefined,
      }),
    ).toBeUndefined();
  });
});
