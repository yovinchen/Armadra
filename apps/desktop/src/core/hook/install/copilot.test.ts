import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { hooksPath, isManagedEntry, uninstall } from "./copilot";
import { CLIENT_NAME, COPILOT_HOOK_EVENTS } from "./events";
import { tempDir } from "../../testing/temp-dir";

function home(): string {
  return tempDir("armadra-copilot-");
}

interface HookFile {
  version?: unknown;
  disableAllHooks?: unknown;
  hooks: Record<string, Record<string, unknown>[]>;
}

/** What the old global installer wrote into `hooks/armadra.json`. */
function ourEntry(): Record<string, unknown> {
  return {
    type: "command",
    exec: "/opt/armadra/armadra-hook",
    args: ["copilot"],
    timeoutSec: 5,
  };
}

function writeOld(path: string, extra: Partial<HookFile> = {}): void {
  const hooks: HookFile["hooks"] = { ...extra.hooks };
  for (const event of COPILOT_HOOK_EVENTS) {
    hooks[event] = [...(hooks[event] ?? []), ourEntry()];
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({ ...extra, version: 1, hooks }, null, 2),
    "utf8",
  );
}

describe("removing the old global Copilot install", () => {
  it("removes a file that was only ever ours", () => {
    const directory = home();
    writeOld(hooksPath(directory));
    const report = uninstall(directory);
    expect(report.installed).toBe(false);
    expect(existsSync(hooksPath(directory))).toBe(false);
    // The directory stays: other hook files may live in it.
    expect(statSync(join(directory, "hooks")).isDirectory()).toBe(true);
  });

  it("lets foreign entries in our own file survive", () => {
    const directory = home();
    const path = hooksPath(directory);
    writeOld(path, {
      disableAllHooks: false,
      hooks: {
        sessionStart: [{ type: "command", bash: "/usr/local/bin/notify.sh" }],
        preToolUse: [
          { type: "command", bash: "/usr/local/bin/audit.sh", matcher: "bash" },
        ],
      },
    });
    uninstall(directory);
    const rendered = readFileSync(path, "utf8");
    expect(rendered).not.toContain(CLIENT_NAME);
    const file = JSON.parse(rendered) as HookFile;
    expect(file.disableAllHooks).toBe(false);
    expect(file.hooks.sessionStart).toHaveLength(1);
    expect(file.hooks.sessionStart?.[0]?.bash).toBe("/usr/local/bin/notify.sh");
    expect(file.hooks.preToolUse?.[0]?.bash).toBe("/usr/local/bin/audit.sh");
  });

  it("never touches other files in the hooks directory", () => {
    const directory = home();
    const hooks = join(directory, "hooks");
    mkdirSync(hooks, { recursive: true });
    const theirs = join(hooks, "team-audit.json");
    const contents = JSON.stringify({
      version: 1,
      hooks: { sessionStart: [{ type: "command", bash: "/opt/audit.sh" }] },
    });
    writeFileSync(theirs, contents, "utf8");
    writeOld(hooksPath(directory));
    uninstall(directory);
    expect(readFileSync(theirs, "utf8")).toBe(contents);
  });

  it("is not an error when nothing was installed", () => {
    const directory = home();
    const report = uninstall(directory);
    expect(report.installed).toBe(false);
    expect(existsSync(hooksPath(directory))).toBe(false);
  });

  it("recognises an entry whichever key names the client", () => {
    for (const key of ["exec", "command", "bash", "powershell"]) {
      expect(isManagedEntry({ [key]: "/opt/armadra-hook" }), key).toBe(true);
    }
    expect(isManagedEntry({ exec: "/usr/bin/other-hook" })).toBe(false);
    expect(isManagedEntry({ type: "http", url: "https://x" })).toBe(false);
    expect(isManagedEntry({ args: ["armadra-hook"] })).toBe(false);
    expect(isManagedEntry("armadra-hook")).toBe(false);
  });
});
