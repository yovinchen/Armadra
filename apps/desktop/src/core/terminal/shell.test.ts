import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { type LaunchWord, shellCommandLine } from "./shell";

/**
 * 生成的启动行真的交给本机的 POSIX shell 读一遍。
 *
 * 逐字的期望值在 `packages/shared/test/shell.test.ts`（与这里同一份规则）；这
 * 里只问一件事：程序拿到的 argv 与环境变量，是不是就是我们要给的那些。
 */

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
  "$HOME",
  "`id`",
  "!x!",
  "画布 说明",
  "C:\\dir with space\\",
  'a\\"b & 100%',
  "‘curly’",
  "",
];

/** 一个把 argv 原样回显成 JSON 的程序。 */
const ECHO = [
  "-e",
  "process.stdout.write(JSON.stringify(process.argv.slice(1)))",
];

const SHELLS = ["/bin/sh", "/bin/bash", "/bin/zsh", "/bin/dash"].filter(
  (shell) => process.platform !== "win32" && existsSync(shell),
);

describe.runIf(SHELLS.length > 0)("POSIX shells read the line back", () => {
  it.each(SHELLS)("%s", (shell) => {
    const words: LaunchWord[] = [
      ...ECHO,
      ...VALUES,
      { prefix: "k=", env: "ARMADRA_PROBE" },
    ];
    const line = shellCommandLine(process.execPath, words, "posix");
    const probe = 'a b "q" $HOME `id` 100% 画布 \\';
    const output = execFileSync(shell, ["-c", line], {
      encoding: "utf8",
      env: { ...process.env, ARMADRA_PROBE: probe },
    });
    expect(JSON.parse(output)).toEqual([...VALUES, `k=${probe}`]);
  });
});
