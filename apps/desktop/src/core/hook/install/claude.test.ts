import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  install,
  isInstalled,
  launchArgs,
  managedContextCommand,
  managedSettingsPath,
  settingsPath,
  uninstall,
} from "./claude";
import { CLAUDE_HOOK_EVENTS, HOOK_CLIENT_REVISION } from "./events";

const CLIENT = "/opt/armadra/armadra-hook";

/** `[the user's config home, our integration home]`. */
function homes(): [string, string] {
  return [
    mkdtempSync(join(tmpdir(), "armadra-claude-config-")),
    mkdtempSync(join(tmpdir(), "armadra-claude-integration-")),
  ];
}

function managed(integration: string): Record<string, never> {
  return JSON.parse(
    readFileSync(managedSettingsPath(integration), "utf8"),
  ) as Record<string, never>;
}

function read(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

describe("the Claude Code installer", () => {
  it("writes our file on a fresh install and never the user's", () => {
    const [config, integration] = homes();
    const report = install(config, integration, CLIENT);
    expect(report.installed).toBe(true);
    expect(report.clientRevision).toBe(HOOK_CLIENT_REVISION);
    // The one thing this whole shape is for.
    expect(
      existsSync(settingsPath(config)),
      "install created a file in the user's config home",
    ).toBe(false);

    const settings = managed(integration) as unknown as {
      hooks: Record<string, { hooks: Record<string, unknown>[] }[]>;
      statusLine: { command: string };
    };
    for (const event of CLAUDE_HOOK_EVENTS) {
      const handler = settings.hooks[event]?.[0]?.hooks[0];
      expect(handler?.type, event).toBe("command");
      expect(handler?.command, event).toBe("/opt/armadra/armadra-hook claude");
      expect(handler?.timeout, event).toBe(5);
    }
    expect(Object.keys(settings.hooks)).toHaveLength(CLAUDE_HOOK_EVENTS.length);
    expect(settings.statusLine.command).toBe(
      "/opt/armadra/armadra-hook context-usage",
    );
  });

  it("points the launch line at the file and says nothing when it is gone", () => {
    const [config, integration] = homes();
    const report = install(config, integration, CLIENT);
    expect(report.launchArgs).toEqual([
      "--settings",
      managedSettingsPath(integration),
    ]);
    expect(isInstalled(integration)).toBe(true);

    uninstall(config, integration);
    expect(isInstalled(integration)).toBe(false);
    // A flag pointing at a file that is not there is an error claude prints on
    // every start, so there is no flag at all.
    expect(launchArgs(managedSettingsPath(integration))).toHaveLength(0);
  });

  it("produces an identical file when installed twice", () => {
    const [config, integration] = homes();
    install(config, integration, CLIENT);
    const first = readFileSync(managedSettingsPath(integration), "utf8");
    install(config, integration, CLIENT);
    expect(readFileSync(managedSettingsPath(integration), "utf8")).toBe(first);
  });

  /**
   * The upgrade path: a machine integrated by the file-writing era has our
   * entries in `~/.claude/settings.json`, where they would keep firing for
   * every session the user starts outside Armadra.
   */
  it("retires entries an earlier Armadra left in the user's file", () => {
    const [config, integration] = homes();
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

    const report = install(config, integration, CLIENT);
    expect(report.warning).toBe("legacy_global_hooks_removed");

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
    const [config, integration] = homes();
    const path = settingsPath(config);
    mkdirSync(config, { recursive: true });
    const original =
      '{\n  "model":"opus",\n  "hooks":{"Stop":[{"hooks":[{"type":"command","command":"theirs.sh"}]}]}\n}\n';
    writeFileSync(path, original, "utf8");

    install(config, integration, CLIENT);
    expect(readFileSync(path, "utf8")).toBe(original);
    uninstall(config, integration);
    expect(readFileSync(path, "utf8")).toBe(original);
  });

  it("keeps ours out of the file entirely when a foreign status line is there", () => {
    const [config, integration] = homes();
    const path = settingsPath(config);
    mkdirSync(config, { recursive: true });
    const foreign = { type: "command", command: "/my/statusline", padding: 3 };
    writeFileSync(path, JSON.stringify({ statusLine: foreign }), "utf8");

    const report = install(config, integration, CLIENT);
    expect(report.warning).toBe("context_statusline_preserved");
    // Not written at all: `--settings` outranks the user's file, so writing
    // one would silently replace theirs for every Armadra session.
    expect(
      (managed(integration) as unknown as Record<string, unknown>).statusLine,
    ).toBeUndefined();
    expect(read(path).statusLine).toEqual(foreign);
  });

  /** An unreadable `settings.json` must not read as "the status line is free". */
  it("counts an unparseable user file as claiming the status line", () => {
    const [config, integration] = homes();
    mkdirSync(config, { recursive: true });
    writeFileSync(settingsPath(config), "{ not json", "utf8");
    // The install itself refuses, because retiring old entries would mean
    // rewriting a file we could not read.
    expect(() => install(config, integration, CLIENT)).toThrow();
  });

  it("is not an error to uninstall when nothing was installed", () => {
    const [config, integration] = homes();
    const report = uninstall(config, integration);
    expect(report.installed).toBe(false);
    expect(existsSync(settingsPath(config))).toBe(false);
    expect(() => uninstall(config, integration)).not.toThrow();
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
