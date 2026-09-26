import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { settingsPath } from "./claude";
import {
  configPath as codexConfigPath,
  hooksPath as codexHooksPath,
} from "./codex";
import { hooksPath as copilotHooksPath } from "./copilot";
import { modulePath } from "./extensions";
import { migrateGlobalInstalls, migrationPath, readMigration } from "./migrate";
import { tempDir } from "../../testing/temp-dir";

const OURS = "/opt/armadra/bin/armadra-hook";
const SKILL =
  "---\nname: armadra\n---\nbody\n<!-- armadra:skill-revision 11 -->\n";

function put(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents, "utf8");
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** Six config homes carrying what the old global installer wrote. */
function oldMachine(): { dataDir: string; homes: Record<string, string> } {
  const root = tempDir("armadra-migrate-");
  const homes: Record<string, string> = {};
  for (const agentId of [
    "claude",
    "codex",
    "opencode",
    "pi",
    "omp",
    "copilot",
  ]) {
    homes[agentId] = join(root, agentId);
    put(join(homes[agentId], "skills", "armadra", "SKILL.md"), SKILL);
  }
  put(
    settingsPath(homes.claude as string),
    json({
      model: "opus",
      hooks: {
        Stop: [
          { hooks: [{ type: "command", command: "/usr/local/bin/mine.sh" }] },
          { hooks: [{ type: "command", command: `${OURS} claude` }] },
        ],
      },
    }),
  );
  const codex = homes.codex as string;
  put(
    codexHooksPath(codex),
    json({
      hooks: {
        Stop: [
          { hooks: [{ type: "command", command: "/usr/local/bin/mine.sh" }] },
          { hooks: [{ type: "command", command: `${OURS} codex` }] },
        ],
      },
    }),
  );
  const source = realpathSync(codexHooksPath(codex));
  put(
    codexConfigPath(codex),
    `model = "gpt-5"\n\n[hooks.state."${source}:stop:0:0"]\ntrusted_hash = "sha256:mine"\n\n[hooks.state."${source}:stop:1:0"]\nenabled = true\ntrusted_hash = "sha256:ours"\n`,
  );
  put(
    copilotHooksPath(homes.copilot as string),
    json({
      version: 1,
      hooks: {
        sessionStart: [{ type: "command", exec: OURS, args: ["copilot"] }],
      },
    }),
  );
  for (const agentId of ["opencode", "pi", "omp"]) {
    put(
      modulePath(agentId, homes[agentId] as string),
      `const ARMADRA_CLIENT = "${OURS}";\n`,
    );
  }
  // Somebody else's plugin, beside ours.
  put(join(homes.opencode as string, "plugins", "theirs.js"), "export {};\n");
  return { dataDir: join(root, "data"), homes };
}

describe("the one-time migration away from global installs", () => {
  it("backs up, removes only ours, and records it once", () => {
    const { dataDir, homes } = oldMachine();
    const now = () => new Date("2026-09-26T01:02:03Z");
    const record = migrateGlobalInstalls({ dataDir, homes, now });

    // Claude: our handler gone, theirs and the rest kept, a backup beside it.
    const claude = homes.claude as string;
    const settings = readFileSync(settingsPath(claude), "utf8");
    expect(settings).not.toContain("armadra-hook");
    expect(settings).toContain("/usr/local/bin/mine.sh");
    expect(settings).toContain('"model": "opus"');
    const claudeBackup = `${settingsPath(claude)}.armadra-backup-20260926010203`;
    expect(readFileSync(claudeBackup, "utf8")).toContain(`${OURS} claude`);
    expect(record.agents.claude?.backups).toContain(claudeBackup);

    // Codex: hooks.json and the trust state move together, both backed up.
    const codex = homes.codex as string;
    expect(readFileSync(codexHooksPath(codex), "utf8")).not.toContain(OURS);
    const config = readFileSync(codexConfigPath(codex), "utf8");
    expect(config).toContain(":stop:0:0");
    expect(config).not.toContain(":stop:1:0");
    expect(config).toContain('model = "gpt-5"');
    expect(
      existsSync(`${codexHooksPath(codex)}.armadra-backup-20260926010203`),
    ).toBe(true);
    expect(
      existsSync(`${codexConfigPath(codex)}.armadra-backup-20260926010203`),
    ).toBe(true);

    // Copilot: a file that was only ours is gone.
    expect(existsSync(copilotHooksPath(homes.copilot as string))).toBe(false);

    // Modules and skills: gone from the scanned directories, kept in the vault.
    for (const agentId of ["opencode", "pi", "omp"]) {
      expect(existsSync(modulePath(agentId, homes[agentId] as string))).toBe(
        false,
      );
    }
    expect(
      existsSync(join(homes.opencode as string, "plugins", "theirs.js")),
    ).toBe(true);
    for (const home of Object.values(homes)) {
      expect(existsSync(join(home, "skills", "armadra"))).toBe(false);
    }
    const vault = join(dataDir, "integration", "global-backup-20260926010203");
    expect(readdirSync(vault).sort()).toEqual(
      ["claude", "codex", "copilot", "omp", "opencode", "pi"].sort(),
    );
    expect(
      readFileSync(join(vault, "pi", "skills", "armadra", "SKILL.md"), "utf8"),
    ).toBe(SKILL);

    expect(readMigration(dataDir)).toEqual(record);
    for (const entry of Object.values(record.agents)) {
      expect(entry.error).toBeUndefined();
    }
  });

  it("does not run twice", () => {
    const { dataDir, homes } = oldMachine();
    migrateGlobalInstalls({ dataDir, homes });
    // Something of ours appears again afterwards: it is not the migration's
    // business any more.
    put(join(homes.pi as string, "skills", "armadra", "SKILL.md"), SKILL);
    const again = migrateGlobalInstalls({ dataDir, homes });
    expect(
      existsSync(join(homes.pi as string, "skills", "armadra", "SKILL.md")),
    ).toBe(true);
    expect(again).toEqual(readMigration(dataDir));
  });

  it("leaves a skill named armadra that is not ours", () => {
    const { dataDir, homes } = oldMachine();
    const mine = join(homes.codex as string, "skills", "armadra", "SKILL.md");
    put(mine, "---\nname: armadra\n---\nmy own notes\n");
    migrateGlobalInstalls({ dataDir, homes });
    expect(readFileSync(mine, "utf8")).toContain("my own notes");
  });

  it("records a machine with nothing to migrate, without backups", () => {
    const root = tempDir("armadra-migrate-empty-");
    const homes = Object.fromEntries(
      ["claude", "codex", "opencode", "pi", "omp", "copilot"].map((id) => [
        id,
        join(root, id),
      ]),
    );
    const dataDir = join(root, "data");
    const record = migrateGlobalInstalls({ dataDir, homes });
    for (const entry of Object.values(record.agents)) {
      expect(entry.removed).toEqual([]);
      expect(entry.backups).toEqual([]);
    }
    expect(existsSync(migrationPath(dataDir))).toBe(true);
  });
});
