import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { codexTomlString } from "../hook/install/inject";
import { tempDir } from "../testing/temp-dir";
import {
  type LaunchWord,
  type ShellDialect,
  shellCommandLine,
} from "../terminal/shell";

/**
 * 启动行真的交给 Windows 的 shell 读一遍（Windows 专用；别的平台跳过）。
 *
 * `terminal/shell.ts` 的单测只比对写出来的字，`cmd.exe` 的读法在那边是模拟的。
 * 这里把生成的整行交给真的 `cmd.exe` 与 PowerShell 执行：程序是一个把 argv 与
 * 环境变量原样回显成 JSON 的 node 脚本，断言每个参数、每个由行展开的环境变量都
 * 一字不差地到了程序手里。
 *
 * 程序直接是 `node.exe`，不经 `.cmd` 包装：批处理的 `%*` 会让 `cmd.exe` 把参数
 * 再读一遍，那是 `.cmd` 自己的问题，任何引用都挡不住（含 `\"` 与 `&` 的参数会
 * 在第二遍里露出来）。
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

function fixture(dialect: ShellDialect): {
  line: string;
  env: NodeJS.ProcessEnv;
} {
  const script = join(tempDir("armadra-windows-launch-"), "echo.js");
  writeFileSync(script, ECHO, "utf8");
  const words: LaunchWord[] = [
    script,
    ...VALUES,
    { prefix: "plain=", env: "ARMADRA_PLAIN" },
    { prefix: "developer_instructions=", env: "ARMADRA_TOML" },
  ];
  return {
    line: shellCommandLine(process.execPath, words, dialect),
    env: {
      ...process.env,
      ARMADRA_PLAIN: PLAIN,
      ARMADRA_TOML: codexTomlString(TOML_SOURCE, dialect),
    },
  };
}

function expectArrived(stdout: string): void {
  const out = JSON.parse(stdout) as { argv: string[]; plain: string };
  expect(out.plain).toBe(PLAIN);
  expect(out.argv.slice(0, VALUES.length)).toEqual(VALUES);
  expect(out.argv[VALUES.length]).toBe(`plain=${PLAIN}`);
  const toml = out.argv[VALUES.length + 1] as string;
  expect(toml.startsWith("developer_instructions=")).toBe(true);
  // Codex 读到的是一条 TOML 基本字符串；这里的转义都是 JSON 也认的那几种。
  expect(JSON.parse(toml.slice("developer_instructions=".length))).toBe(
    TOML_SOURCE,
  );
  expect(out.argv).toHaveLength(VALUES.length + 2);
}

const windows = process.platform === "win32";

describe("launch lines read by the real Windows shells", () => {
  it.runIf(windows)("cmd.exe", () => {
    const { line, env } = fixture("cmd");
    // `/s /c "…"`：去掉最外一层引号，其余照交互时敲进去的那样读；`/d` 不跑
    // AutoRun。整行不能再经 node 按 C 运行库的规则转义一遍。
    const result = spawnSync(
      process.env.COMSPEC ?? "cmd.exe",
      ["/d", "/s", "/c", `"${line}"`],
      { env, encoding: "utf8", windowsVerbatimArguments: true },
    );
    expect(result.status, result.stderr).toBe(0);
    expectArrived(result.stdout);
  });

  /**
   * PowerShell 7.3 起把参数按 C 运行库的规则交给原生程序，值里的 `"` 才能原样
   * 到达；Windows PowerShell 5.1 做不到，所以这里只跑 `pwsh`。
   */
  const pwsh = windows
    ? spawnSync(
        "pwsh",
        ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.Major"],
        {
          encoding: "utf8",
        },
      )
    : undefined;
  const modern =
    pwsh !== undefined && pwsh.status === 0 && Number(pwsh.stdout.trim()) >= 7;

  it.runIf(windows && modern)("PowerShell 7", () => {
    const { line, env } = fixture("powershell");
    const result = spawnSync(
      "pwsh",
      [
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(line, "utf16le").toString("base64"),
      ],
      { env, encoding: "utf8" },
    );
    expect(result.status, result.stderr).toBe(0);
    expectArrived(result.stdout);
  });
});
