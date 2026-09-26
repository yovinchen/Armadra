import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { configPath, hookHash, hooksPath, uninstall } from "./codex";
import { stateKeys } from "./toml-state";
import { tempDir } from "../../testing/temp-dir";

const DEFAULT_TIMEOUT_SEC = 600;
const SESSION_END_TIMEOUT_SEC = 1;

function home(): string {
  return tempDir("armadra-codex-");
}

function readHooks(path: string): {
  hooks?: Record<string, { hooks: { command: string }[] }[]>;
} {
  return JSON.parse(readFileSync(path, "utf8")) as {
    hooks?: Record<string, { hooks: { command: string }[] }[]>;
  };
}

describe("Codex's hook trust", () => {
  /**
   * Locks the trust algorithm. It was verified byte-for-byte against the
   * hashes a real Codex 0.149.1 wrote into its own hooks.json (every handler
   * running the same command). If this test ever fails, the algorithm drifted
   * from Codex and our hooks stopped firing silently.
   */
  it("matches the trusted hash Codex 0.149.1 wrote", () => {
    const command =
      "if [ -x '/Users/yovinchen/.other-tool/agent-hooks/codex.sh' ]; then " +
      "/bin/sh '/Users/yovinchen/.other-tool/agent-hooks/codex.sh'; fi";
    const expected: [string, string][] = [
      [
        "session_start",
        "sha256:2a10016abb2a496a442493f17b6c9b53b3f8a9fbcf23a65e61fdaa35f65de2ef",
      ],
      [
        "user_prompt_submit",
        "sha256:f77c87d9bf8d78dae7c6506fb0b8309b64b0e7ae1f6ca4970d1f0f9dcdae5a07",
      ],
      [
        "pre_tool_use",
        "sha256:64831f48fa3bd20575ceb4e41195d9e1bde5ae694574d13495d3a56aebcf769d",
      ],
      [
        "permission_request",
        "sha256:e48306563758a740a2538144910f7a4cd6c14c077d7159f0b5cf705ca6516915",
      ],
      [
        "post_tool_use",
        "sha256:4b05dab673761b38e1555ca204e9077db39e50af66f3c28634cf74b97604f7c3",
      ],
      [
        "subagent_start",
        "sha256:2b6dd592f3e12fc623ce8d2ab558d403459775b7aabfaa5f1a17729e2c560cf8",
      ],
      [
        "subagent_stop",
        "sha256:84fb9f0f7fa6cb8d51e55e5c44784dc1e456323fc62822ac0898ea35a52f69aa",
      ],
      [
        "stop",
        "sha256:dbd54e9db7463cbebab1a108d58bd898e2467c078e90d74b825bd2c4d26f1709",
      ],
    ];
    for (const [event, hash] of expected) {
      expect(
        hookHash(event, undefined, command, DEFAULT_TIMEOUT_SEC),
        event,
      ).toBe(hash);
    }
    // The event name and the timeout are both inside the hash.
    expect(hookHash("stop", undefined, command, DEFAULT_TIMEOUT_SEC)).not.toBe(
      hookHash("session_end", undefined, command, SESSION_END_TIMEOUT_SEC),
    );
    expect(hookHash("stop", undefined, command, DEFAULT_TIMEOUT_SEC)).not.toBe(
      hookHash("stop", "Bash", command, DEFAULT_TIMEOUT_SEC),
    );
  });

  /**
   * The same algorithm for hooks passed with `-c hooks.<Event>=…`: the
   * `currentHash` that `codex app-server`'s `hooks/list` reported on Codex
   * 0.155.1 (2026-09-26) for three session-flag hooks, one with a matcher and
   * one with `SessionEnd`'s 1s timeout.
   */
  it("matches the session-flag hashes Codex 0.155.1 reports", () => {
    const command = "/tmp/inj-data/bin/armadra-hook codex";
    expect(hookHash("pre_tool_use", "*", command, DEFAULT_TIMEOUT_SEC)).toBe(
      "sha256:f85777c8eeea904aa7682a18b449009d6839537cd84fe33a607ac6733da3dff3",
    );
    expect(
      hookHash("session_start", undefined, command, DEFAULT_TIMEOUT_SEC),
    ).toBe(
      "sha256:4ed3d9273f76ebab86355439f2683ef2010e26fe15187e05e887a0f84722b4db",
    );
    expect(
      hookHash("session_end", undefined, command, SESSION_END_TIMEOUT_SEC),
    ).toBe(
      "sha256:18ac34824d1ac73a2043780af8339d5165f3eb4d3b6432dacd9ce608e708401d",
    );
  });
});

describe("removing the old global Codex install", () => {
  it("takes out our handlers and their trust, and keeps the user's", () => {
    const directory = home();
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      hooksPath(directory),
      JSON.stringify({
        version: 1,
        hooks: {
          Stop: [
            {
              hooks: [{ type: "command", command: "/usr/local/bin/theirs.sh" }],
            },
            {
              hooks: [
                { type: "command", command: "/opt/armadra/armadra-hook codex" },
              ],
            },
          ],
          SessionStart: [
            {
              hooks: [
                { type: "command", command: "/opt/armadra/armadra-hook codex" },
              ],
            },
          ],
        },
      }),
      "utf8",
    );
    const source = realpathSync(hooksPath(directory));
    // 键是 TOML 基本字符串，要像 Codex 写的那样转义：Windows 路径里的 `\U`、`\A`
    // 原样写进去就成了转义序列，读回来已经不是这个路径。
    const header = (key: string) => `[hooks.state.${JSON.stringify(key)}]`;
    writeFileSync(
      configPath(directory),
      [
        "# my config",
        'model = "gpt-5"',
        "",
        header(`${source}:stop:0:0`),
        'trusted_hash = "sha256:theirs"',
        "",
        header(`${source}:stop:1:0`),
        "enabled = true",
        'trusted_hash = "sha256:ours"',
        "",
        header(`${source}:session_start:0:0`),
        "enabled = true",
        'trusted_hash = "sha256:ours"',
        "",
      ].join("\n"),
      "utf8",
    );

    uninstall(directory);

    const hooks = readHooks(hooksPath(directory));
    expect(Object.keys(hooks.hooks ?? {})).toEqual(["Stop"]);
    expect(hooks.hooks?.Stop).toHaveLength(1);
    expect(hooks.hooks?.Stop?.[0]?.hooks[0]?.command).toBe(
      "/usr/local/bin/theirs.sh",
    );
    // A top-level key Codex would reject is dropped on the way.
    expect(readFileSync(hooksPath(directory), "utf8")).not.toContain("version");
    const config = readFileSync(configPath(directory), "utf8");
    expect(config).toContain("# my config");
    expect(stateKeys(config)).toEqual([`${source}:stop:0:0`]);
  });

  it("is not an error when there was never an install", () => {
    const directory = home();
    expect(() => uninstall(directory)).not.toThrow();
  });
});
