import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { codexTomlString } from "../hook/install/inject";
import { tempDir } from "../testing/temp-dir";
import {
  type LaunchWord,
  type ShellDialect,
  shellCommandLine,
} from "../terminal/shell";
import { launchTargetOf, resolveCommand } from "./registry";

/**
 * 启动行真的交给 Windows 的 shell 读一遍（Windows 专用；别的平台跳过）。
 *
 * `terminal/shell.ts` 的单测只比对写出来的字，`cmd.exe` 的读法在那边是模拟的。
 * 这里把生成的整行交给真的 `cmd.exe` 与 PowerShell 执行：程序是一个把 argv 与
 * 环境变量原样回显成 JSON 的 node 脚本，断言每个参数、每个由行展开的环境变量都
 * 一字不差地到了程序手里。
 *
 * 前三条的程序直接是 `node.exe`。批处理的 `%*` 会让 `cmd.exe` 把参数再读一遍，
 * 任何引用都挡不住（含 `\"` 与 `&` 的参数会在第二遍里露出来），所以启动行绕过
 * npm 的 `.cmd` 包装（`windows-shim.ts`）——后两条造一个包装，走的就是这条路。
 */

/** 各种要特殊处理的字符；`cmd.exe` 收不了换行，这里没有。 */
const VALUES = [
  "plain",
  "a b",
  "it's",
  'say "hi"',
  "100%",
  "%PATH%",
  "a^b",
  "a&b",
  "a|b",
  "<in> (group)",
  "$HOME",
  "`id`",
  "!x!",
  "画布 说明",
  "C:\\dir with space\\",
  "C:\\dir\\",
  'a\\"b & 100%',
  "",
];

/**
 * 由行展开的环境变量：一个普通值，和 Codex 那样的 TOML 串。`cmd.exe` 把值原样
 * 贴进引号里，所以普通值里不能有 `"`、也不能以 `\` 结尾（见 `shellEnvWord`）；
 * 带引号的值要像 Codex 的那样先写成 `codexTomlString` 的形状。
 */
const PLAIN = "a b & c | d <e> 100% ^f 画布 C:\\dir\\x";
const TOML_SOURCE =
  'hook "C:\\Program Files\\armadra-hook.exe" codex & 100% 画布';

const ECHO = [
  "const out = { argv: process.argv.slice(2), plain: process.env.ARMADRA_PLAIN };",
  // 只输出 ASCII：控制台代码页不该决定断言。
  "process.stdout.write(JSON.stringify(out).replace(/[\\u0080-\\uffff]/g, (c) => '\\\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')));",
].join("\n");

/** 启动行开头的程序与它自己要的词：直接的 `node.exe <脚本>`，或者包装。 */
interface Launch {
  readonly program: string;
  readonly args: readonly string[];
}

function echoScript(root = tempDir("armadra-windows-launch-")): string {
  const script = join(root, "echo.js");
  writeFileSync(script, ECHO, "utf8");
  return script;
}

function fixture(
  dialect: ShellDialect,
  values: readonly string[] = VALUES,
  launch: Launch = { program: process.execPath, args: [echoScript()] },
): {
  line: string;
  env: NodeJS.ProcessEnv;
} {
  const words: LaunchWord[] = [
    ...launch.args,
    ...values,
    { prefix: "plain=", env: "ARMADRA_PLAIN" },
    { prefix: "developer_instructions=", env: "ARMADRA_TOML" },
  ];
  return {
    line: shellCommandLine(launch.program, words, dialect),
    env: {
      ...process.env,
      ARMADRA_PLAIN: PLAIN,
      ARMADRA_TOML: codexTomlString(TOML_SOURCE, dialect),
    },
  };
}

function expectArrived(
  stdout: string,
  values: readonly string[] = VALUES,
): void {
  const out = JSON.parse(stdout) as { argv: string[]; plain: string };
  expect(out.plain).toBe(PLAIN);
  expect(out.argv.slice(0, values.length)).toEqual(values);
  expect(out.argv[values.length]).toBe(`plain=${PLAIN}`);
  const toml = out.argv[values.length + 1] as string;
  expect(toml.startsWith("developer_instructions=")).toBe(true);
  // Codex 读到的是一条 TOML 基本字符串；这里的转义都是 JSON 也认的那几种。
  expect(JSON.parse(toml.slice("developer_instructions=".length))).toBe(
    TOML_SOURCE,
  );
  expect(out.argv).toHaveLength(values.length + 2);
}

/** `cmd.exe /d /s /c "<行>"`：去掉最外一层引号，其余照交互时敲进去的那样读。 */
function runCmd(line: string, env: NodeJS.ProcessEnv) {
  return spawnSync(
    process.env.COMSPEC ?? "cmd.exe",
    ["/d", "/s", "/c", `"${line}"`],
    {
      env,
      encoding: "utf8",
      windowsVerbatimArguments: true,
    },
  );
}

function runPowerShell(program: string, line: string, env: NodeJS.ProcessEnv) {
  return spawnSync(
    program,
    [
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(line, "utf16le").toString("base64"),
    ],
    { env, encoding: "utf8" },
  );
}

const windows = process.platform === "win32";

function powershellMajor(program: string): number {
  if (!windows) return 0;
  const probe = spawnSync(
    program,
    ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.Major"],
    { encoding: "utf8" },
  );
  return probe.status === 0 ? Number(probe.stdout.trim()) : 0;
}

/**
 * PowerShell 7.3 起把参数按 C 运行库的规则交给原生程序，值里的 `"` 才能原样
 * 到达；Windows PowerShell 5.1 做不到，它的行在 `--%` 之后写（`shell.ts`），
 * 那里带不了 `%` 与 `|`。
 */
const modern = powershellMajor("pwsh") >= 7;
const legacy = powershellMajor("powershell.exe") === 5;
const LEGACY_VALUES = VALUES.filter((value) => !/[%|]/.test(value));

describe("launch lines read by the real Windows shells", () => {
  it.runIf(windows)("cmd.exe", () => {
    // `/d` 不跑 AutoRun；整行不能再经 node 按 C 运行库的规则转义一遍。
    const { line, env } = fixture("cmd");
    const result = runCmd(line, env);
    expect(result.status, result.stderr).toBe(0);
    expectArrived(result.stdout);
  });

  it.runIf(windows && modern)("PowerShell 7", () => {
    const { line, env } = fixture("powershell");
    const result = runPowerShell("pwsh", line, env);
    expect(result.status, result.stderr).toBe(0);
    expectArrived(result.stdout);
  });

  it.runIf(windows && legacy)("Windows PowerShell 5.1", () => {
    const { line, env } = fixture("windows-powershell", LEGACY_VALUES);
    expect(line).toContain(" --% ");
    const result = runPowerShell("powershell.exe", line, env);
    expect(result.status, result.stderr).toBe(0);
    expectArrived(result.stdout, LEGACY_VALUES);
  });
});

/**
 * npm 装的 CLI 在 Windows 上是 `.cmd` 包装。这里照 npm 7–10 的 cmd-shim 格式
 * 造一个，指向同一个回显脚本：`launchTargetOf` 读出它背后的 `node <脚本>`，
 * 整行绕过包装，于是 `.cmd` 挡不住的那些值也原样到达。读不出来的包装留作程
 * 序本身，只放行两遍都读不坏的值。
 */
describe("npm wrappers on Windows", () => {
  function npmShim(): { shim: string; script: string } {
    const root = tempDir("armadra-windows-shim-");
    const bin = join(root, "node_modules", "fake-cli", "bin");
    mkdirSync(bin, { recursive: true });
    const script = echoScript(bin);
    const shim = join(root, "fake.cmd");
    writeFileSync(
      shim,
      [
        "@ECHO off",
        "GOTO start",
        ":find_dp0",
        "SET dp0=%~dp0",
        "EXIT /b",
        ":start",
        "SETLOCAL",
        "CALL :find_dp0",
        "",
        'IF EXIST "%dp0%\\node.exe" (',
        '  SET "_prog=%dp0%\\node.exe"',
        ") ELSE (",
        '  SET "_prog=node"',
        "  SET PATHEXT=%PATHEXT:;.JS;=;%",
        ")",
        "",
        'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\fake-cli\\bin\\echo.js" %*',
        "",
      ].join("\r\n"),
      "utf8",
    );
    return { shim, script };
  }

  it.runIf(windows)("starts node past the wrapper, every value intact", () => {
    const { shim, script } = npmShim();
    expect(resolveCommand(shim)).toBe(shim);
    const target = launchTargetOf(shim);
    expect(target?.args).toEqual([script]);
    expect(target?.program.toLowerCase()).toMatch(/node\.exe$/);
    const { line, env } = fixture("cmd", VALUES, target as Launch);
    const result = runCmd(line, env);
    expect(result.status, result.stderr).toBe(0);
    expectArrived(result.stdout);
  });

  it.runIf(windows)("keeps an unreadable wrapper to the safe words", () => {
    const root = tempDir("armadra-windows-batch-");
    const script = echoScript(root);
    const shim = join(root, "mine.cmd");
    writeFileSync(
      shim,
      `@echo off\r\nset "PROG=${process.execPath}"\r\n"%PROG%" "${script}" %*\r\n`,
      "utf8",
    );
    expect(launchTargetOf(shim)).toBeUndefined();
    const safe = [
      "plain",
      "a b",
      "it's",
      "$HOME",
      "`id`",
      "!x!",
      "C:\\dir\\",
      "",
    ];
    const words: LaunchWord[] = [
      ...safe,
      { prefix: "plain=", env: "ARMADRA_SAFE" },
    ];
    const result = runCmd(shellCommandLine(shim, words, "cmd"), {
      ...process.env,
      ARMADRA_SAFE: "a b c",
    });
    expect(result.status, result.stderr).toBe(0);
    const out = JSON.parse(result.stdout) as { argv: string[] };
    expect(out.argv).toEqual([...safe, "plain=a b c"]);
    expect(() => shellCommandLine(shim, ["a&b"], "cmd")).toThrow(/batch/);
  });
});
