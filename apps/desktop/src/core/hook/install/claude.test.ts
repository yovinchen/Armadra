import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  managedContextCommand,
  retireGlobalEntries,
  settingsPath,
} from "./claude";
import { tempDir } from "../../testing/temp-dir";

function home(): string {
  return tempDir("armadra-claude-config-");
}

function read(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

/**
 * What an earlier Armadra left in `~/.claude/settings.json`, and its removal.
 * Claude's own hooks now travel on the launch line (`inject.test.ts`); this
 * file only covers the file we used to write into.
 */
describe("retiring Claude's global entries", () => {
  /**
   * The upgrade path: a machine integrated by the file-writing era has our
   * entries in `~/.claude/settings.json`, where they would keep firing for
   * every session the user starts outside Armadra.
   */
  it("retires entries an earlier Armadra left in the user's file", () => {
    const config = home();
    const path = settingsPath(config);
    mkdirSync(config, { recursive: true });
    writeFileSync(
      path,
      JSON.stringify(
        {
          model: "opus",
          statusLine: {
            type: "command",
            command: "/old/armadra-hook context-usage",
          },
          hooks: {
            Stop: [
              {
                hooks: [
                  { type: "command", command: "/usr/local/bin/notify.sh" },
                ],
              },
              {
                hooks: [
                  { type: "command", command: "/old/armadra-hook claude" },
                ],
              },
            ],
            SessionEnd: [
              {
                hooks: [
                  { type: "command", command: "/old/armadra-hook claude" },
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

    expect(retireGlobalEntries(config)).toBe(true);

    const rendered = readFileSync(path, "utf8");
    expect(rendered, rendered).not.toContain("armadra-hook");
    const settings = read(path) as {
      model: string;
      hooks: Record<string, { hooks: { command: string }[] }[]>;
      statusLine?: unknown;
    };
    expect(settings.model).toBe("opus");
    // Theirs survives; the event that was only ours is gone entirely.
    expect(settings.hooks.Stop).toHaveLength(1);
    expect(settings.hooks.Stop?.[0]?.hooks[0]?.command).toBe(
      "/usr/local/bin/notify.sh",
    );
    expect(settings.hooks.SessionEnd).toBeUndefined();
    expect(settings.statusLine).toBeUndefined();
  });

  it("leaves a user file with nothing of ours in it byte for byte", () => {
    const config = home();
    const path = settingsPath(config);
    mkdirSync(config, { recursive: true });
    const original =
      '{\n  "model":"opus",\n  "hooks":{"Stop":[{"hooks":[{"type":"command","command":"theirs.sh"}]}]}\n}\n';
    writeFileSync(path, original, "utf8");

    expect(retireGlobalEntries(config)).toBe(false);
    expect(readFileSync(path, "utf8")).toBe(original);
  });

  it("never touches a status line that is not recognisably ours", () => {
    const config = home();
    const path = settingsPath(config);
    mkdirSync(config, { recursive: true });
    const foreign = { type: "command", command: "/my/statusline", padding: 3 };
    writeFileSync(path, JSON.stringify({ statusLine: foreign }), "utf8");

    retireGlobalEntries(config);
    expect(read(path).statusLine).toEqual(foreign);
  });

  /**
   * The era with the context readout left our `statusLine` in the user's own
   * file, naming a subcommand that no longer does anything.
   */
  it("takes our own old status line back out", () => {
    const config = home();
    const path = settingsPath(config);
    mkdirSync(config, { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({
        model: "opus",
        statusLine: {
          type: "command",
          command: "/opt/armadra/armadra-hook context-usage",
        },
      }),
      "utf8",
    );
    retireGlobalEntries(config);
    const settings = read(path) as { model: string; statusLine?: unknown };
    expect(settings.statusLine).toBeUndefined();
    expect(settings.model).toBe("opus");
  });

  /** An unreadable `settings.json` must not read as "the status line is free". */
  it("counts an unparseable user file as claiming the status line", () => {
    const config = home();
    mkdirSync(config, { recursive: true });
    writeFileSync(settingsPath(config), "{ not json", "utf8");
    // Retiring old entries would mean rewriting a file we could not read.
    expect(() => retireGlobalEntries(config)).toThrow();
  });

  it("is not an error when there is no settings file", () => {
    const config = home();
    expect(retireGlobalEntries(config)).toBe(false);
    expect(existsSync(settingsPath(config))).toBe(false);
  });

  it("recognises the status line command only when it is plainly ours", () => {
    expect(
      managedContextCommand("echo /opt/armadra/armadra-hook context-usage"),
    ).toBe(false);
    expect(
      managedContextCommand("/tmp/armadra-hook context-usage; echo other"),
    ).toBe(false);
    expect(
      managedContextCommand(
        '"C:/Program Files/Armadra/armadra-hook.exe" context-usage',
      ),
    ).toBe(true);
    expect(
      managedContextCommand(
        '"/Applications/Armadra App/armadra-hook" context-usage',
      ),
    ).toBe(true);
  });
});
