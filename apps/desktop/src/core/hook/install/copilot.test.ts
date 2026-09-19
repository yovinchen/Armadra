import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { hooksPath, install, isManagedEntry, uninstall } from "./copilot";
import {
  CLIENT_NAME,
  COPILOT_HOOK_EVENTS,
  HOOK_CLIENT_REVISION,
} from "./events";

const CLIENT = "/opt/armadra/armadra-hook";

function home(): string {
  return mkdtempSync(join(tmpdir(), "armadra-copilot-"));
}

interface HookFile {
  version?: unknown;
  disableAllHooks?: unknown;
  hooks: Record<string, Record<string, unknown>[]>;
}

function read(path: string): HookFile {
  return JSON.parse(readFileSync(path, "utf8")) as HookFile;
}

describe("the GitHub Copilot installer", () => {
  it("subscribes every event but the blocking one", () => {
    const directory = home();
    const report = install(directory, CLIENT);
    expect(report.installed).toBe(true);
    expect(report.clientRevision).toBe(HOOK_CLIENT_REVISION);
    expect(report.configPath).toBe(hooksPath(directory));

    const file = read(hooksPath(directory));
    expect(file.version).toBe(1);
    for (const event of COPILOT_HOOK_EVENTS) {
      const entry = file.hooks[event]?.[0];
      expect(entry?.type, event).toBe("command");
      expect(entry?.exec, event).toBe("/opt/armadra/armadra-hook");
      expect(entry?.args, event).toEqual(["copilot"]);
      expect(entry?.timeoutSec, event).toBe(5);
      // `exec` + `args` never goes through a shell, so there is nothing to
      // quote and nothing to escape.
      expect(entry?.bash, event).toBeUndefined();
      expect(entry?.command, event).toBeUndefined();
    }
    expect(Object.keys(file.hooks)).toHaveLength(COPILOT_HOOK_EVENTS.length);
    // §6: subscribing Copilot's only fail-closed event would make a missing
    // binary deny every tool call.
    expect(file.hooks.preToolUse).toBeUndefined();
    expect(file.hooks.PreToolUse).toBeUndefined();
    expect(file.hooks.permissionRequest).toBeUndefined();
  });

  it("produces an identical file when installed twice", () => {
    const directory = home();
    install(directory, CLIENT);
    const first = readFileSync(hooksPath(directory), "utf8");
    install(directory, CLIENT);
    expect(readFileSync(hooksPath(directory), "utf8")).toBe(first);
    // And a third time, after the entries have been read back once.
    install(directory, CLIENT);
    expect(readFileSync(hooksPath(directory), "utf8")).toBe(first);
  });

  it("replaces a stale entry rather than duplicating it", () => {
    const directory = home();
    const path = hooksPath(directory);
    mkdirSync(dirname(path), { recursive: true });
    // What an older revision wrote: a shell command instead of `exec`.
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        hooks: {
          sessionStart: [
            {
              type: "command",
              bash: "/old/armadra-hook copilot",
              timeoutSec: 30,
            },
          ],
        },
      }),
      "utf8",
    );
    install(directory, CLIENT);
    const entries = read(path).hooks.sessionStart ?? [];
    expect(entries).toHaveLength(1);
    expect(entries[0]?.exec).toBe("/opt/armadra/armadra-hook");
  });

  it("lets foreign entries in our own file survive the round trip", () => {
    const directory = home();
    const path = hooksPath(directory);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify(
        {
          version: 1,
          disableAllHooks: false,
          hooks: {
            sessionStart: [
              { type: "command", bash: "/usr/local/bin/notify.sh" },
            ],
            preToolUse: [
              {
                type: "command",
                bash: "/usr/local/bin/audit.sh",
                matcher: "bash",
              },
            ],
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    install(directory, CLIENT);
    let file = read(path);
    expect(file.disableAllHooks).toBe(false);
    // Theirs stays first; ours is appended.
    expect(file.hooks.sessionStart).toHaveLength(2);
    expect(file.hooks.sessionStart?.[0]?.bash).toBe("/usr/local/bin/notify.sh");
    expect(file.hooks.sessionStart?.[1]?.exec).toBe(
      "/opt/armadra/armadra-hook",
    );
    // An event we never subscribe to is left exactly as it was — including the
    // one we refuse to touch.
    expect(file.hooks.preToolUse?.[0]?.bash).toBe("/usr/local/bin/audit.sh");
    expect(file.hooks.preToolUse).toHaveLength(1);

    uninstall(directory);
    const rendered = readFileSync(path, "utf8");
    expect(rendered).not.toContain(CLIENT_NAME);
    file = JSON.parse(rendered) as HookFile;
    expect(file.disableAllHooks).toBe(false);
    expect(file.hooks.sessionStart).toHaveLength(1);
    expect(file.hooks.sessionStart?.[0]?.bash).toBe("/usr/local/bin/notify.sh");
    expect(file.hooks.preToolUse?.[0]?.bash).toBe("/usr/local/bin/audit.sh");
  });

  it("removes a file that was only ever ours", () => {
    const directory = home();
    install(directory, CLIENT);
    expect(existsSync(hooksPath(directory))).toBe(true);
    const report = uninstall(directory);
    expect(report.installed).toBe(false);
    expect(existsSync(hooksPath(directory))).toBe(false);
    // The directory stays: other hook files may live in it.
    expect(statSync(join(directory, "hooks")).isDirectory()).toBe(true);
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

    install(directory, CLIENT);
    expect(readFileSync(theirs, "utf8")).toBe(contents);
    uninstall(directory);
    expect(readFileSync(theirs, "utf8")).toBe(contents);
  });

  it("is not an error to uninstall when nothing was installed", () => {
    const directory = home();
    const report = uninstall(directory);
    expect(report.installed).toBe(false);
    expect(existsSync(hooksPath(directory))).toBe(false);
  });

  it("replaces a hooks key of the wrong type rather than merging it", () => {
    const directory = home();
    const path = hooksPath(directory);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ hooks: [], version: 1 }), "utf8");
    install(directory, CLIENT);
    expect(Array.isArray(read(path).hooks)).toBe(false);
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
