import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isLegacyCommand, repairIn, scanIn } from "./repair";
import { SKILLS_ROOT } from "./skills";
import { tempDir } from "../../testing/temp-dir";

function home(): string {
  return tempDir("armadra-repair-");
}

function readJson(path: string): Record<string, never> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, never>;
}

describe("recognising what an earlier product name left behind", () => {
  it("calls a command legacy when it names a binary of ours that is gone", () => {
    expect(isLegacyCommand("/usr/local/bin/aicc-hook claude")).toBe(true);
    expect(isLegacyCommand("~/.nodeterm/bin/hook codex")).toBe(true);
    expect(isLegacyCommand("/repo/target/debug/armadra-hook claude")).toBe(
      true,
    );
    expect(
      isLegacyCommand(String.raw`C:\repo\target\debug\armadra-hook.exe claude`),
    ).toBe(true);
    // The current install, and a stranger's, are both left alone.
    expect(isLegacyCommand("/opt/armadra/armadra-hook claude")).toBe(false);
    expect(isLegacyCommand("/usr/local/bin/notify.sh")).toBe(false);
  });
});

describe("repairing an instruction file", () => {
  /**
   * The `~/.codex/AGENTS.md` one user actually had: two legacy instruction
   * blocks around their own text. Only the blocks go; the backup keeps the
   * whole.
   */
  it("loses only its legacy marked blocks", () => {
    const directory = home();
    const path = join(directory, "AGENTS.md");
    const text =
      "# Mine\n\nkeep this line\n\n" +
      "<!-- nodeterm:get-linked-context:start -->\nold words\n<!-- nodeterm:get-linked-context:end -->\n\n" +
      "<!-- nodeterm:manage-canvas:start -->\nsh nodeterm.sh open-claude\n<!-- nodeterm:manage-canvas:end -->\n\n" +
      "<!-- somebody:else:start -->\ntheirs\n<!-- somebody:else:end -->\n\n" +
      "<!-- aicc:dangling:start -->\nno end marker\n";
    writeFileSync(path, text, "utf8");

    const found = scanIn("codex", directory);
    expect(
      found
        .filter((one) => one.kind === "instruction_block")
        .map((one) => one.detail),
    ).toEqual(["nodeterm:get-linked-context", "nodeterm:manage-canvas"]);

    const report = repairIn("codex", directory);
    const after = readFileSync(path, "utf8");
    expect(after, after).toContain("keep this line");
    expect(after, after).toContain("<!-- somebody:else:start -->");
    expect(after, after).toContain("<!-- aicc:dangling:start -->");
    expect(after, after).not.toContain("nodeterm");
    expect(after, after).not.toContain("\n\n\n");
    expect(
      report.removed.some((entry) => entry.includes("nodeterm:manage-canvas")),
    ).toBe(true);
    const backup = report.backup as string;
    expect(readFileSync(backup, "utf8")).toContain("open-claude");
    expect(
      scanIn("codex", directory).every(
        (one) => one.kind !== "instruction_block",
      ),
    ).toBe(true);
  });
});

/**
 * The shapes users actually reported, written here rather than read off a real
 * machine: a fixture that reads `~/.claude` would repair the developer's own
 * configuration the first time somebody ran the suite.
 */
function claudeFixture(): [string, string] {
  const directory = home();
  const path = join(directory, "settings.json");
  writeFileSync(
    path,
    JSON.stringify(
      {
        model: "opus",
        statusLine: {
          type: "command",
          command: "/usr/local/bin/aicc-hook context-usage",
        },
        hooks: {
          Stop: [
            {
              hooks: [
                {
                  type: "command",
                  command: "/usr/local/bin/aicc-hook claude",
                },
              ],
            },
            {
              hooks: [{ type: "command", command: "/usr/local/bin/notify.sh" }],
            },
          ],
          SessionStart: [
            {
              hooks: [
                {
                  type: "command",
                  command:
                    "/Users/dev/nodeterm/target/debug/armadra-hook claude",
                },
              ],
            },
          ],
        },
      },
      null,
      2,
    ),
    "utf8",
  );
  return [directory, path];
}

describe("repairing a hook file", () => {
  it("backs a Claude file up and removes only our entries", () => {
    const [directory, path] = claudeFixture();
    const found = scanIn("claude", directory);
    expect(found, JSON.stringify(found)).toHaveLength(3);
    expect(found.some((one) => one.kind === "status_line")).toBe(true);
    expect(found.filter((one) => one.kind === "hook_entry")).toHaveLength(2);

    const report = repairIn("claude", directory);
    const backup = report.backup as string;
    expect(backup).toContain(".armadra-backup-");
    // The backup is the file as it was.
    expect(readFileSync(backup, "utf8")).toContain("aicc-hook");

    const settings = readJson(path) as unknown as {
      model: string;
      statusLine?: unknown;
      hooks: Record<string, { hooks: { command: string }[] }[]>;
    };
    expect(settings.model).toBe("opus");
    expect(settings.statusLine).toBeUndefined();
    // Their notify hook survives; the event that was only ours is gone.
    expect(settings.hooks.Stop).toHaveLength(1);
    expect(settings.hooks.Stop?.[0]?.hooks[0]?.command).toBe(
      "/usr/local/bin/notify.sh",
    );
    expect(settings.hooks.SessionStart).toBeUndefined();
    expect(
      report.kept.some((entry) => entry.includes("/usr/local/bin/notify.sh")),
    ).toBe(true);

    // Repairing twice finds nothing and writes no second backup.
    const again = repairIn("claude", directory);
    expect(again.found, JSON.stringify(again.found)).toHaveLength(0);
    expect(again.backup).toBeUndefined();
  });

  /**
   * The reported Codex failure: a top-level `version` some other installer
   * wrote makes Codex reject the whole file, so nobody's hooks run.
   */
  it("rewrites a Codex file with an unknown top-level key", () => {
    const directory = home();
    const path = join(directory, "hooks.json");
    writeFileSync(
      path,
      JSON.stringify(
        {
          version: 1,
          description: "hooks",
          hooks: {
            session_start: [
              {
                hooks: [
                  {
                    type: "command",
                    command: "/usr/local/bin/aicc-hook codex",
                  },
                ],
              },
              { hooks: [{ type: "command", command: "/opt/audit.sh" }] },
            ],
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const found = scanIn("codex", directory);
    expect(
      found.some(
        (one) => one.kind === "codex_unknown_key" && one.detail === "version",
      ),
    ).toBe(true);

    const report = repairIn("codex", directory);
    expect(report.backup).toBeDefined();
    const document = readJson(path) as unknown as {
      version?: unknown;
      description: string;
      hooks: Record<string, { hooks: { command: string }[] }[]>;
    };
    expect(document.version).toBeUndefined();
    expect(document.description).toBe("hooks");
    expect(document.hooks.session_start).toHaveLength(1);
    expect(document.hooks.session_start?.[0]?.hooks[0]?.command).toBe(
      "/opt/audit.sh",
    );
  });

  it("removes a Copilot file that was only ours and rewrites a shared one", () => {
    const directory = home();
    const hooks = join(directory, "hooks");
    mkdirSync(hooks, { recursive: true });
    writeFileSync(
      join(hooks, "armadra.json"),
      JSON.stringify(
        {
          version: 1,
          hooks: {
            sessionStart: [
              {
                type: "command",
                exec: "/usr/local/bin/aicc-hook",
                args: ["copilot"],
              },
            ],
          },
        },
        null,
        2,
      ),
      "utf8",
    );
    writeFileSync(
      join(hooks, "theirs.json"),
      JSON.stringify(
        {
          version: 1,
          hooks: {
            sessionStart: [
              {
                type: "command",
                exec: "/opt/nodeterm/hook",
                args: ["copilot"],
              },
              { type: "command", exec: "/opt/mine.sh" },
            ],
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    expect(scanIn("copilot", directory)).toHaveLength(2);
    const report = repairIn("copilot", directory);
    expect(existsSync(join(hooks, "armadra.json"))).toBe(false);
    const theirs = readJson(join(hooks, "theirs.json")) as unknown as {
      hooks: Record<string, { exec: string }[]>;
    };
    expect(theirs.hooks.sessionStart).toHaveLength(1);
    expect(theirs.hooks.sessionStart?.[0]?.exec).toBe("/opt/mine.sh");
    expect(report.backups, JSON.stringify(report.backups)).toHaveLength(2);
  });

  it("never rewrites a file it cannot parse", () => {
    const directory = home();
    const path = join(directory, "settings.json");
    writeFileSync(path, "{ not json", "utf8");
    expect(scanIn("claude", directory)).toHaveLength(0);
    const report = repairIn("claude", directory);
    expect(report.removed).toHaveLength(0);
    expect(readFileSync(path, "utf8")).toBe("{ not json");
  });
});

describe("repairing skills and generated modules", () => {
  it("removes legacy skill directories and keeps a user file beside one", () => {
    const directory = home();
    const root = join(directory, SKILLS_ROOT);
    for (const name of [
      "aicc-canvas",
      "get-linked-context",
      "manage-nodeterm-canvas",
    ]) {
      mkdirSync(join(root, name), { recursive: true });
      writeFileSync(
        join(root, name, "SKILL.md"),
        "---\nname: old\n---\n",
        "utf8",
      );
    }
    // Something of the user's, in a directory that is otherwise ours.
    writeFileSync(join(root, "aicc-canvas", "notes.md"), "mine", "utf8");
    // The current skill is not residue, however it got there.
    mkdirSync(join(root, "armadra"), { recursive: true });
    writeFileSync(join(root, "armadra", "SKILL.md"), "current", "utf8");

    const found = scanIn("claude", directory);
    expect(found.filter((one) => one.kind === "skill_dir")).toHaveLength(3);

    const report = repairIn("claude", directory);
    expect(existsSync(join(root, "get-linked-context"))).toBe(false);
    expect(existsSync(join(root, "manage-nodeterm-canvas"))).toBe(false);
    // Ours went; theirs stayed, and the report says the directory remains.
    expect(existsSync(join(root, "aicc-canvas", "SKILL.md"))).toBe(false);
    expect(readFileSync(join(root, "aicc-canvas", "notes.md"), "utf8")).toBe(
      "mine",
    );
    expect(report.kept.some((entry) => entry.includes("aicc-canvas"))).toBe(
      true,
    );
    expect(statSync(join(root, "armadra", "SKILL.md")).isFile()).toBe(true);
  });

  it("deletes a generated module from the old name and not a stranger's", () => {
    const directory = home();
    const extensions = join(directory, "extensions");
    mkdirSync(extensions, { recursive: true });
    writeFileSync(
      join(extensions, "aicc-status.ts"),
      'const CLIENT = "/usr/local/bin/aicc-hook";\n',
      "utf8",
    );
    writeFileSync(
      join(extensions, "theirs.ts"),
      "export default () => {};\n",
      "utf8",
    );

    expect(scanIn("pi", directory)).toHaveLength(1);
    repairIn("pi", directory);
    expect(existsSync(join(extensions, "aicc-status.ts"))).toBe(false);
    expect(statSync(join(extensions, "theirs.ts")).isFile()).toBe(true);
  });
});
