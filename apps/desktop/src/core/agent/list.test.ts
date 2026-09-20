import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { install as installIntegration } from "../hook/install/integration";
import { type AgentListRow, listAgents } from "./list";
import { AGENT_IDS, type AgentSettings, type CustomAgent } from "./registry";
import { type AgentFixture, agentFixture } from "./fixture";

/**
 * `GET /api/agents`.
 *
 * The field names are asserted one by one rather than loosely: this list is
 * what the new-node menu, the command palette and every settings page parse
 * through `agentListSchema`, and a key this core spelled differently would
 * empty all four at once with no error anyone could see. The core has no
 * dependency on `@armadra/shared`, so the schema cannot be imported here —
 * the names below are the contract, copied deliberately.
 *
 * Every case that touches an integration passes an explicit `env`. The config
 * home comes from `CLAUDE_CONFIG_DIR` and friends, so a suite that left it
 * alone would read the developer's own `~/.claude` and pass or fail depending
 * on whose machine ran it.
 */

let fixture: AgentFixture;
let home: string;
let hookBin: string;

function isolated(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    // The installer writes a hook entry naming a real file; the suite supplies
    // a stub rather than the packaged sidecar, which does not exist in a test.
    ARMADRA_HOOK_BIN: hookBin,
    HOME: home,
    CLAUDE_CONFIG_DIR: join(home, "claude"),
    CODEX_HOME: join(home, "codex"),
    COPILOT_HOME: join(home, "copilot"),
    XDG_CONFIG_HOME: join(home, "xdg"),
    PI_CODING_AGENT_DIR: join(home, "pi"),
  };
}

beforeEach(() => {
  fixture = agentFixture();
  home = mkdtempSync(join(tmpdir(), "armadra-agents-"));
  hookBin = join(home, "armadra-hook");
  writeFileSync(hookBin, "#!/bin/sh\n", "utf8");
});

afterEach(() => {
  fixture.close();
  rmSync(home, { recursive: true, force: true });
});

describe("GET /api/agents", () => {
  it("answers one row per built-in adapter, in a shape the page parses", async () => {
    const answer = await fixture.call("GET", "/api/agents");
    expect(answer.status).toBe(200);
    const rows = answer.body as AgentListRow[];
    expect(rows.map((row) => row.id)).toEqual([...AGENT_IDS]);
    const claude = rows.find((row) => row.id === "claude");
    expect(claude?.label).toBe("Claude Code");
    expect(claude?.promptMode).toBe("argv");
    expect(claude?.capabilities).toContain("contextLink");
  });

  it("lists a custom agent after the built-ins, with its base borrowed", async () => {
    fixture.customAgents.push({
      id: "custom:mine",
      label: "My Claude",
      baseAgent: "claude",
      launchCmd: "/nope/claude-wrapper",
      args: ["--flag"],
    });
    const rows = (await fixture.call("GET", "/api/agents"))
      .body as AgentListRow[];
    const mine = rows.at(-1);
    expect(mine?.id).toBe("custom:mine");
    expect(mine?.baseAgent).toBe("claude");
    expect(mine?.args).toEqual(["--flag"]);
    // The wrapper is not on this box, so the row says so instead of guessing.
    expect(mine?.installed).toBe(false);
    expect(mine?.resolvedPath).toBeNull();
  });
});

describe("listAgents and the integration", () => {
  const settings = (custom: CustomAgent[] = []): AgentSettings => ({
    customAgents: () => custom,
  });

  it("omits both revisions and the argv while nothing is installed", () => {
    const rows = listAgents({
      dataDir: fixture.directory,
      settings: settings(),
      env: isolated(),
    });
    const claude = rows.find((row) => row.id === "claude");
    // Absent, not zero: `0` would read as "integrated, by an ancient build".
    expect(claude?.clientRevision).toBeUndefined();
    expect(claude?.skillsRevision).toBeUndefined();
    expect(claude?.launchArgs).toBeUndefined();
  });

  it("carries `--settings <file>` once Claude's adapter is installed", () => {
    const env = isolated();
    installIntegration("claude", { dataDir: fixture.directory, env });
    const rows = listAgents({
      dataDir: fixture.directory,
      settings: settings(),
      env,
    });
    const claude = rows.find((row) => row.id === "claude");
    // The path is inside *this* data directory, which is why the argv is
    // answered per request rather than frozen into a launch definition.
    expect(claude?.launchArgs?.[0]).toBe("--settings");
    expect(claude?.launchArgs?.[1]).toContain(fixture.directory);
    expect(claude?.clientRevision).toBeGreaterThan(0);
    // Codex was not installed, so its row is untouched by Claude's.
    expect(rows.find((row) => row.id === "codex")?.launchArgs).toBeUndefined();
  });

  it("gives a custom entry the integration of the base it borrows", () => {
    const env = isolated();
    installIntegration("claude", { dataDir: fixture.directory, env });
    const rows = listAgents({
      dataDir: fixture.directory,
      settings: settings([
        {
          id: "custom:mine",
          label: "My Claude",
          baseAgent: "claude",
          launchCmd: "/nope/claude-wrapper",
        },
      ]),
      env,
    });
    const mine = rows.find((row) => row.id === "custom:mine");
    expect(mine?.launchArgs?.[0]).toBe("--settings");
    expect(mine?.clientRevision).toBeGreaterThan(0);
  });
});
