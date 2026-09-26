import { describe, expect, it } from "vitest";

import {
  quoteShellWord,
  shellCommandLine,
  shellDialect,
  shellEnvWord,
  type ShellDialect,
} from "../src/shell";

/**
 * 每个值在四种方言里该写成什么。期望值逐条手写：哪一条变了，就是引用规则变
 * 了，要能在评审里看见。
 */
const WORDS: readonly {
  value: string;
  posix: string;
  fish: string;
  cmd: string;
  powershell: string;
}[] = [
  {
    value: "plain-value_1.2/3",
    posix: "plain-value_1.2/3",
    fish: "plain-value_1.2/3",
    cmd: "plain-value_1.2/3",
    powershell: "plain-value_1.2/3",
  },
  {
    value: "a b",
    posix: "'a b'",
    fish: "'a b'",
    cmd: '"a b"',
    powershell: "'a b'",
  },
  {
    value: "it's",
    posix: "'it'\\''s'",
    fish: "'it\\'s'",
    cmd: '"it\'s"',
    powershell: "'it''s'",
  },
  {
    value: 'say "hi"',
    posix: "'say \"hi\"'",
    fish: "'say \"hi\"'",
    cmd: '^"say \\^"hi\\^"^"',
    powershell: "'say \"hi\"'",
  },
  {
    value: "100%",
    posix: "100%",
    fish: "'100%'",
    cmd: '^"100^%^"',
    powershell: "'100%'",
  },
  {
    value: "%PATH%",
    posix: "%PATH%",
    fish: "'%PATH%'",
    cmd: '^"^%PATH^%^"',
    powershell: "'%PATH%'",
  },
  {
    value: "a^b",
    posix: "'a^b'",
    fish: "'a^b'",
    cmd: '"a^b"',
    powershell: "'a^b'",
  },
  {
    value: "a&b",
    posix: "'a&b'",
    fish: "'a&b'",
    cmd: '"a&b"',
    powershell: "'a&b'",
  },
  {
    value: "a|b",
    posix: "'a|b'",
    fish: "'a|b'",
    cmd: '"a|b"',
    powershell: "'a|b'",
  },
  {
    value: "$HOME",
    posix: "'$HOME'",
    fish: "'$HOME'",
    cmd: '"$HOME"',
    powershell: "'$HOME'",
  },
  {
    value: "`id`",
    posix: "'`id`'",
    fish: "'`id`'",
    cmd: '"`id`"',
    powershell: "'`id`'",
  },
  {
    value: "画布 说明",
    posix: "'画布 说明'",
    fish: "'画布 说明'",
    cmd: '"画布 说明"',
    powershell: "'画布 说明'",
  },
  {
    value: "C:\\dir with space\\",
    posix: "'C:\\dir with space\\'",
    fish: "'C:\\\\dir with space\\\\'",
    cmd: '"C:\\dir with space\\\\"',
    powershell: "'C:\\dir with space\\'",
  },
  {
    value: "C:\\dir\\",
    posix: "'C:\\dir\\'",
    fish: "'C:\\\\dir\\\\'",
    cmd: "C:\\dir\\",
    powershell: "C:\\dir\\",
  },
  {
    value: 'a\\"b & 100%',
    posix: "'a\\\"b & 100%'",
    fish: "'a\\\\\"b & 100%'",
    cmd: '^"a\\\\\\^"b ^& 100^%^"',
    powershell: "'a\\\"b & 100%'",
  },
  {
    value: "!x!",
    posix: "'!x!'",
    fish: "'!x!'",
    cmd: '^"^!x^!^"',
    powershell: "'!x!'",
  },
  {
    value: "‘curly’",
    posix: "'‘curly’'",
    fish: "'‘curly’'",
    cmd: '"‘curly’"',
    powershell: "'‘‘curly’’'",
  },
  { value: "", posix: "''", fish: "''", cmd: '""', powershell: "''" },
];

const DIALECTS: readonly ShellDialect[] = [
  "posix",
  "fish",
  "cmd",
  "powershell",
];

describe("quoteShellWord", () => {
  for (const dialect of DIALECTS) {
    it.each(WORDS)(`${dialect}: %j`, (row) => {
      expect(quoteShellWord(row.value, dialect)).toBe(row[dialect]);
    });
  }

  it("refuses a line break for cmd.exe, which ends the command there", () => {
    expect(() => quoteShellWord("a\nb", "cmd")).toThrow(/line break/);
  });
});

describe("shellEnvWord", () => {
  it.each([
    ["posix", '"hooks.Stop=${ARMADRA_CODEX_HOOK}"'],
    ["fish", '"hooks.Stop=$ARMADRA_CODEX_HOOK"'],
    ["cmd", '"hooks.Stop=%ARMADRA_CODEX_HOOK%"'],
    ["powershell", '"hooks.Stop=${env:ARMADRA_CODEX_HOOK}"'],
  ] as const)("%s", (dialect, expected) => {
    expect(shellEnvWord("hooks.Stop=", "ARMADRA_CODEX_HOOK", dialect)).toBe(
      expected,
    );
  });

  it("escapes what the double quotes would still interpret in the prefix", () => {
    expect(shellEnvWord('a$`"\\', "V", "posix")).toBe('"a\\$\\`\\"\\\\${V}"');
    expect(shellEnvWord('a$"\\', "V", "fish")).toBe('"a\\$\\"\\\\$V"');
    expect(shellEnvWord('a$`"', "V", "powershell")).toBe('"a`$```"${env:V}"');
    expect(() => shellEnvWord("100%", "V", "cmd")).toThrow();
    expect(() => shellEnvWord("x", "not a name", "posix")).toThrow();
  });
});

describe("shellDialect", () => {
  it.each([
    ["/bin/zsh", "posix"],
    ["/opt/homebrew/bin/bash", "posix"],
    ["/usr/local/bin/fish", "fish"],
    ["C:\\Windows\\System32\\cmd.exe", "cmd"],
    ["powershell.exe", "powershell"],
    ["C:\\Program Files\\PowerShell\\7\\pwsh.exe", "powershell"],
    ["C:\\Program Files\\Git\\bin\\bash.exe", "posix"],
    ["nu", "posix"],
    [undefined, "posix"],
  ] as const)("%s → %s", (shell, dialect) => {
    expect(shellDialect(shell)).toBe(dialect);
  });
});

describe("shellCommandLine", () => {
  it("puts PowerShell's call operator in front of a quoted program", () => {
    expect(
      shellCommandLine("C:\\Program Files\\x.exe", ["a b"], "powershell"),
    ).toBe("& 'C:\\Program Files\\x.exe' 'a b'");
    expect(shellCommandLine("codex", ["a b"], "powershell")).toBe(
      "codex 'a b'",
    );
    expect(shellCommandLine("C:\\Program Files\\x.exe", ["a"], "cmd")).toBe(
      '"C:\\Program Files\\x.exe" a',
    );
  });
});

/**
 * `cmd.exe` 的读法，只模拟启动行用得到的那几步：先展开 `%NAME%`（未定义的原
 * 样留下），再在引号外去掉 `^`、遇到没转义的 `& | < >` 就算失败，最后把参数
 * 部分交给 Windows C 运行库的规则切开。真的 shell 读一遍在 core 那边
 * （`apps/desktop/src/core/terminal/shell.test.ts`）。
 */
function readAsCmd(line: string, env: Record<string, string>): string[] {
  let expanded = "";
  for (let at = 0; at < line.length; ) {
    const start = line.indexOf("%", at);
    if (start === -1) {
      expanded += line.slice(at);
      break;
    }
    const end = line.indexOf("%", start + 1);
    const name = end === -1 ? undefined : line.slice(start + 1, end);
    if (name !== undefined && name in env) {
      expanded += line.slice(at, start) + env[name];
      at = end + 1;
    } else {
      expanded += line.slice(at, start + 1);
      at = start + 1;
    }
  }
  let unescaped = "";
  let quoted = false;
  for (let at = 0; at < expanded.length; at += 1) {
    const char = expanded[at] as string;
    if (char === '"') quoted = !quoted;
    else if (!quoted && char === "^") {
      at += 1;
      unescaped += expanded[at] ?? "";
      continue;
    } else if (!quoted && "&|<>".includes(char)) {
      throw new Error(`cmd.exe would act on ${char} in ${expanded}`);
    }
    unescaped += char;
  }
  return windowsArgv(unescaped);
}

function windowsArgv(text: string): string[] {
  const args: string[] = [];
  let current: string | undefined;
  let quoted = false;
  for (let at = 0; at < text.length; at += 1) {
    const char = text[at] as string;
    if (char === "\\") {
      let slashes = 0;
      while (text[at] === "\\") {
        slashes += 1;
        at += 1;
      }
      if (text[at] === '"') {
        current = (current ?? "") + "\\".repeat(Math.floor(slashes / 2));
        if (slashes % 2 === 1) current += '"';
        else {
          at -= 1;
        }
      } else {
        current = (current ?? "") + "\\".repeat(slashes);
        at -= 1;
      }
      continue;
    }
    if (char === '"') {
      if (quoted && text[at + 1] === '"') {
        current = (current ?? "") + '"';
        at += 1;
      } else {
        quoted = !quoted;
        current ??= "";
      }
      continue;
    }
    if (!quoted && (char === " " || char === "\t")) {
      if (current !== undefined) args.push(current);
      current = undefined;
      continue;
    }
    current = (current ?? "") + char;
  }
  if (current !== undefined) args.push(current);
  return args;
}

describe("cmd.exe reads it back (modelled)", () => {
  it("hands every value to the program unchanged", () => {
    const values = WORDS.map((row) => row.value);
    const line = shellCommandLine("prog", values, "cmd");
    expect(readAsCmd(line, { PATH: "C:\\Windows" }).slice(1)).toEqual(values);
  });

  it("expands a variable reference into one argument", () => {
    const line = shellCommandLine("prog", [{ prefix: "k=", env: "V" }], "cmd");
    expect(readAsCmd(line, { V: "a b & c" }).slice(1)).toEqual(["k=a b & c"]);
  });
});
