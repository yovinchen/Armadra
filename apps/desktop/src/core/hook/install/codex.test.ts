import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  configPath,
  eventKey,
  hookHash,
  hooksPath,
  install,
  trustEntries,
  uninstall,
} from "./codex";
import { CODEX_HOOK_EVENTS } from "./events";
import { isManagedCommand } from "./shared";
import { stateKeys } from "./toml-state";

const CLIENT = "/opt/armadra/armadra-hook";
const DEFAULT_TIMEOUT_SEC = 600;
const SESSION_END_TIMEOUT_SEC = 1;

function home(): string {
  return mkdtempSync(join(tmpdir(), "armadra-codex-"));
}

function readHooks(path: string): {
  version?: unknown;
  hooks: Record<string, { hooks: { command: string }[] }[]>;
} {
  return JSON.parse(readFileSync(path, "utf8")) as {
    version?: unknown;
    hooks: Record<string, { hooks: { command: string }[] }[]>;
  };
}

/** The key source a fresh install will have written, resolved the same way. */
function keySourceOf(config: string): string {
  const key = stateKeys(config).find((one) => one.endsWith(":stop:0:0"));
  return (key ?? "").slice(0, -":stop:0:0".length);
}

describe("the Codex installer", () => {
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
      expect(hookHash(event, undefined, command, DEFAULT_TIMEOUT_SEC), event)
        .toBe(hash);
    }
    // The event name and the timeout are both inside the hash.
    expect(hookHash("stop", undefined, command, DEFAULT_TIMEOUT_SEC)).not.toBe(
      hookHash("session_end", undefined, command, SESSION_END_TIMEOUT_SEC),
    );
    expect(hookHash("stop", undefined, command, DEFAULT_TIMEOUT_SEC)).not.toBe(
      hookHash("stop", "Bash", command, DEFAULT_TIMEOUT_SEC),
    );
  });

  it("writes hooks.json and a trust entry per handler on a fresh install", () => {
    const directory = home();
    const report = install(directory, CLIENT);
    expect(report.installed).toBe(true);
    // The registry only contains supported Codex events.
    expect(report.warning).toBeUndefined();

    const hooks = readHooks(hooksPath(directory));
    for (const event of CODEX_HOOK_EVENTS.filter(
      (one) => eventKey(one) !== undefined,
    )) {
      expect(hooks.hooks[event]?.[0]?.hooks[0]?.command, event).toBe(
        "/opt/armadra/armadra-hook codex",
      );
    }
    expect(hooks.hooks.Notification).toBeUndefined();

    const config = readFileSync(configPath(directory), "utf8");
    const keySource = keySourceOf(config);
    expect(keySource).not.toBe("");
    expect(config).toContain(`[hooks.state."${keySource}:stop:0:0"]`);
    expect(config).toContain("enabled = true");
    // SessionEnd hashes with the 1s timeout, not the 600s default.
    expect(config).toContain(
      hookHash(
        "session_end",
        undefined,
        "/opt/armadra/armadra-hook codex",
        SESSION_END_TIMEOUT_SEC,
      ),
    );
  });

  it("produces identical files when installed twice", () => {
    const directory = home();
    install(directory, CLIENT);
    const hooks = readFileSync(hooksPath(directory), "utf8");
    const config = readFileSync(configPath(directory), "utf8");
    install(directory, CLIENT);
    expect(readFileSync(hooksPath(directory), "utf8")).toBe(hooks);
    expect(readFileSync(configPath(directory), "utf8")).toBe(config);
  });

  it("lets foreign hooks and foreign config survive", () => {
    const directory = home();
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      hooksPath(directory),
      JSON.stringify({
        version: 1,
        hooks: {
          Stop: [
            {
              hooks: [
                { type: "command", command: "/usr/local/bin/theirs.sh" },
              ],
            },
          ],
        },
      }),
      "utf8",
    );
    writeFileSync(
      configPath(directory),
      '# my config\nmodel = "gpt-5"\n\n[hooks.state."other:stop:0:0"]\ntrusted_hash = "sha256:beef"\n',
      "utf8",
    );

    install(directory, CLIENT);
    const hooks = readHooks(hooksPath(directory));
    expect(
      hooks.version,
      "a top-level key Codex would reject is dropped",
    ).toBeUndefined();
    expect(hooks.hooks.Stop?.[0]?.hooks[0]?.command).toBe(
      "/usr/local/bin/theirs.sh",
    );
    expect(
      hooks.hooks.Stop?.[1]?.hooks[0]?.command,
      "ours is appended so their index 0 never moves",
    ).toBe("/opt/armadra/armadra-hook codex");

    let config = readFileSync(configPath(directory), "utf8");
    expect(config).toContain("# my config");
    expect(config).toContain('model = "gpt-5"');
    expect(config).toContain('[hooks.state."other:stop:0:0"]');
    const keySource = stateKeys(config)
      .find((key) => key.endsWith(":stop:1:0"))
      ?.slice(0, -":stop:1:0".length) as string;
    // Their handler is at index 0 and we did not invent a hash for it.
    expect(config).not.toContain(`${keySource}:stop:0:0`);
    expect(config).toContain(`${keySource}:stop:1:0`);

    uninstall(directory);
    const after = readHooks(hooksPath(directory));
    expect(after.hooks.Stop).toHaveLength(1);
    expect(after.hooks.Stop?.[0]?.hooks[0]?.command).toBe(
      "/usr/local/bin/theirs.sh",
    );
    config = readFileSync(configPath(directory), "utf8");
    expect(config, "foreign trust untouched").toContain(
      '[hooks.state."other:stop:0:0"]',
    );
    expect(config, "our trust entry is gone").not.toContain(
      `${keySource}:stop:1:0`,
    );
    expect(readFileSync(hooksPath(directory), "utf8")).not.toContain(
      "armadra-hook",
    );
  });

  it("trusts only our own command", () => {
    const events = {
      Stop: [
        { hooks: [{ type: "command", command: "/usr/local/bin/theirs.sh" }] },
        {
          hooks: [
            { type: "command", command: "/opt/armadra/armadra-hook codex" },
          ],
        },
      ],
    };
    const entries = trustEntries(
      events,
      "/home/dev/.codex/hooks.json",
      "/opt/armadra/armadra-hook codex",
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]?.key).toBe("/home/dev/.codex/hooks.json:stop:1:0");
    expect(isManagedCommand("/opt/armadra/armadra-hook codex")).toBe(true);
  });

  it("refuses a config.toml it would mangle rather than rewriting it", () => {
    const directory = home();
    mkdirSync(directory, { recursive: true });
    writeFileSync(configPath(directory), "this is [not toml\n", "utf8");
    expect(() => install(directory, CLIENT)).toThrow(/not valid TOML/);
  });
});
