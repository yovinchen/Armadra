/**
 * The settings document: defaults, per-section normalisation, custom agents.
 *
 * Ported case for case from the pre-merge implementation. Where a Rust
 * case asserts on a typed accessor this asserts on the document, because the
 * document is what `GET /api/settings` hands the page and is therefore the part
 * that is contractual.
 */

import { describe, expect, it } from "vitest";

import {
  MAX_CUSTOM_ENV_VALUE,
  parseCustomAgents,
  validAgentId,
  validEnvKey,
} from "./custom-agents";
import type { JsonObject, JsonValue } from "./local";
import { normalize } from "./schema";
import { parseHosts, validateHost } from "./ssh-hosts";

function object(value: JsonValue | undefined): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`expected an object, got ${JSON.stringify(value)}`);
  }
  return value;
}

function at(document: JsonObject, path: string): JsonValue | undefined {
  let current: JsonValue = document;
  for (const segment of path.split(".")) {
    if (
      typeof current !== "object" ||
      current === null ||
      Array.isArray(current)
    ) {
      return undefined;
    }
    const next: JsonValue | undefined = current[segment];
    if (next === undefined) return undefined;
    current = next;
  }
  return current;
}

describe("normalize", () => {
  it("fills the defaults in and lets unknown keys survive", () => {
    const document = normalize({ editor: { fontSize: 13 } });
    expect(at(document, "terminal.backend")).toBe("auto");
    expect(at(document, "terminal.detachedGraceMinutes")).toBe(1440);
    expect(at(document, "usage.enabled")).toBe(true);
    // The whole point of normalising rather than validating: a key written by a
    // newer build is not a key this one gets to drop.
    expect(at(document, "editor.fontSize")).toBe(13);
  });

  it("falls back to the defaults for invalid values", () => {
    const document = normalize({
      terminal: { backend: "screen", detachedGraceMinutes: 0 },
    });
    expect(at(document, "terminal.backend")).toBe("auto");
    expect(at(document, "terminal.detachedGraceMinutes")).toBe(1440);
  });

  it("keeps dormancy off when it was asked for, and clamps the rest", () => {
    // `0` is a real choice, so it survives where `1` would not.
    expect(
      at(
        normalize({ terminal: { dormantAfterSeconds: 0 } }),
        "terminal.dormantAfterSeconds",
      ),
    ).toBe(0);
    expect(
      at(
        normalize({ terminal: { dormantAfterSeconds: 1 } }),
        "terminal.dormantAfterSeconds",
      ),
    ).toBe(120);
    expect(
      at(
        normalize({ terminal: { dormantAfterSeconds: 999_999 } }),
        "terminal.dormantAfterSeconds",
      ),
    ).toBe(120);
    expect(
      at(
        normalize({ terminal: { dormantAfterSeconds: 60 } }),
        "terminal.dormantAfterSeconds",
      ),
    ).toBe(60);
  });

  it("defaults update preferences to checking but not downloading", () => {
    const document = normalize({});
    expect(at(document, "updates.channel")).toBe("stable");
    expect(at(document, "updates.autoCheck")).toBe(true);
    // Spending somebody's bandwidth is a choice they make, not one they
    // discover.
    expect(at(document, "updates.autoDownload")).toBe(false);
    // The notification and the tray item are the only two ways of learning a
    // restart is waiting without opening the settings page, so it starts on.
    expect(at(document, "updates.notify")).toBe(true);

    const chosen = normalize({
      updates: {
        channel: "beta",
        autoCheck: false,
        autoDownload: true,
        notify: false,
      },
    });
    expect(at(chosen, "updates.channel")).toBe("beta");
    expect(at(chosen, "updates.autoCheck")).toBe(false);
    expect(at(chosen, "updates.autoDownload")).toBe(true);
    expect(at(chosen, "updates.notify")).toBe(false);
  });

  it("snaps an unknown update channel back to stable", () => {
    // Including "development", which describes a build rather than a
    // preference: asking for it would not turn a released build into one.
    for (const channel of ["development", "nightly", "", "Stable", 7, null]) {
      const document = normalize({ updates: { channel } as JsonObject });
      expect(at(document, "updates.channel"), String(channel)).toBe("stable");
    }
    const broken = normalize({
      updates: { autoCheck: "yes", autoDownload: 1, notify: "off" },
    });
    expect(at(broken, "updates.autoCheck")).toBe(true);
    expect(at(broken, "updates.autoDownload")).toBe(false);
    expect(at(broken, "updates.notify")).toBe(true);
  });

  it("can switch usage off and drops providers nobody has a module for", () => {
    expect(at(normalize({}), "usage.enabled")).toBe(true);
    const off = normalize({ usage: { enabled: false } });
    expect(at(off, "usage.enabled")).toBe(false);

    const providers = object(
      at(
        normalize({ usage: { providers: { claude: false, invented: true } } }),
        "usage.providers",
      ),
    );
    expect(providers.claude).toBe(false);
    // A switch for a provider the core cannot query would be a switch that
    // does nothing.
    expect("invented" in providers).toBe(false);
    expect(providers.codex).toBe(true);
    expect(providers.copilot).toBe(true);
  });

  it("snaps a refresh cadence and a retention outside the offered sets", () => {
    expect(
      at(normalize({ usage: { refreshMinutes: 7 } }), "usage.refreshMinutes"),
    ).toBe(5);
    expect(
      at(normalize({ usage: { refreshMinutes: 0 } }), "usage.refreshMinutes"),
    ).toBe(0);
    expect(
      at(normalize({ logs: { retentionDays: 45 } }), "logs.retentionDays"),
    ).toBe(30);
    expect(
      at(normalize({ logs: { retentionDays: 0 } }), "logs.retentionDays"),
    ).toBe(0);
  });

  it("clamps the resource sampling interval and snaps the power policy", () => {
    expect(at(normalize({}), "resources.intervalMs")).toBe(2_000);
    expect(
      at(normalize({ resources: { intervalMs: 10 } }), "resources.intervalMs"),
    ).toBe(500);
    expect(
      at(
        normalize({ resources: { intervalMs: 600_000 } }),
        "resources.intervalMs",
      ),
    ).toBe(60_000);
    // The safest reading of a broken value is the conservative default, not a
    // machine that refuses to sleep.
    expect(at(normalize({ power: { policy: "always" } }), "power.policy")).toBe(
      "manual",
    );
    expect(at(normalize({ power: { policy: "never" } }), "power.policy")).toBe(
      "never",
    );
    // 工作时防休眠默认开；只认布尔值，别的写法回到默认。
    expect(at(normalize({}), "power.keepAwakeWhileWorking")).toBe(true);
    expect(
      at(
        normalize({ power: { keepAwakeWhileWorking: false } }),
        "power.keepAwakeWhileWorking",
      ),
    ).toBe(false);
    expect(
      at(
        normalize({ power: { keepAwakeWhileWorking: "no" } }),
        "power.keepAwakeWhileWorking",
      ),
    ).toBe(true);
  });

  it("stores a browser path as written and defaults the two switches", () => {
    const document = normalize({
      browser: { executablePath: "  /opt/chrome  " },
    });
    expect(at(document, "browser.executablePath")).toBe("/opt/chrome");
    expect(at(document, "browser.keepAlive")).toBe(true);
    expect(at(document, "browser.headful")).toBe(false);
    // An empty string means "detect", and is what a cleared field becomes.
    expect(
      at(
        normalize({ browser: { executablePath: "   " } }),
        "browser.executablePath",
      ),
    ).toBe("");
  });

  it("normalises the language scalars and leaves the server map alone", () => {
    const document = normalize({
      language: {
        idleStopSeconds: 999_999,
        maxServers: 100,
        maxRssBytes: 1,
        servers: { invented: { path: "/x" } },
      },
    });
    expect(at(document, "language.idleStopSeconds")).toBe(600);
    expect(at(document, "language.maxServers")).toBe(24);
    // Too small to hold any real server, so clamped up rather than turned into
    // an instant kill loop.
    expect(at(document, "language.maxRssBytes")).toBe(128 * 1024 * 1024);
    expect(at(document, "language.formatOnSave")).toBe(false);
    // `servers` is the user's map and may hold ids this build never heard of.
    expect(at(document, "language.servers.invented.path")).toBe("/x");
    // `0` is "no ceiling" and is kept.
    expect(
      at(normalize({ language: { maxRssBytes: 0 } }), "language.maxRssBytes"),
    ).toBe(0);
  });
});

describe("ssh hosts", () => {
  it("keeps a valid host and never lets an invalid one back in", () => {
    const document = normalize({
      ssh: {
        hosts: [
          {
            id: "box",
            name: "Box",
            host: "example.com",
            user: "ada",
            port: 2222,
          },
          { id: "evil", name: "Evil", host: "a;rm -rf /" },
        ],
      },
    });
    const hosts = parseHosts(document);
    expect(hosts).toHaveLength(1);
    expect(hosts[0]?.host).toBe("example.com");
    expect(hosts[0]?.user).toBe("ada");
    expect(hosts[0]?.port).toBe(2222);
    // Normalising rewrites the array, so the invalid entry is gone from the
    // document the API hands out and not only from the parsed list.
    expect(at(document, "ssh.hosts")).toHaveLength(1);
  });

  it("names the field that is wrong", () => {
    const valid = { id: "box", name: "Box", host: "example.com" };
    expect(validateHost(valid)).toBeNull();
    expect(validateHost({ ...valid, id: "has space" })).toBe("id");
    expect(validateHost({ ...valid, name: "   " })).toBe("name");
    expect(validateHost({ ...valid, host: "a;rm -rf /" })).toBe("host");
    expect(validateHost({ ...valid, user: "ada bell" })).toBe("user");
    expect(validateHost({ ...valid, port: 0 })).toBe("port");
    // A relative identity path would be resolved against whatever directory
    // `ssh` happened to start in.
    expect(validateHost({ ...valid, identityFile: "key" })).toBe(
      "identityFile",
    );
    expect(
      validateHost({ ...valid, identityFile: "/home/ada/.ssh/id" }),
    ).toBeNull();
    expect(validateHost({ ...valid, extraArgs: ["bare"] })).toBe("extraArgs");
    expect(validateHost({ ...valid, extraArgs: ["-o", "-4"] })).toBeNull();
    expect(validateHost({ ...valid, worker: { path: "armadra" } })).toBe(
      "worker.path",
    );
    expect(
      validateHost({ ...valid, worker: { path: "/opt/armadra" } }),
    ).toBeNull();
  });

  /**
   * These turn `ssh` into a local command runner, or undo the host-key decision
   * Armadra makes on the user's behalf. Neither is shell injection — there is
   * no shell — which is exactly why a generic "no metacharacters" rule does not
   * catch them.
   */
  it("refuses the ssh options that would execute a program or re-enable blind trust", () => {
    const valid = { id: "box", name: "Box", host: "example.com" };
    for (const option of [
      "-oProxyCommand=nc",
      "-oLocalCommand=x",
      "-oPermitLocalCommand=yes",
      "-oStrictHostKeyChecking=no",
      "-oUserKnownHostsFile=/dev/null",
      "-oGlobalKnownHostsFile=/dev/null",
      // Case is not a defence.
      "-oproxycommand=nc",
    ]) {
      expect(validateHost({ ...valid, extraArgs: [option] }), option).toBe(
        "extraArgs",
      );
    }
  });

  it("de-duplicates ids, first one wins", () => {
    const hosts = parseHosts({
      ssh: {
        hosts: [
          { id: "box", name: "First", host: "a.example" },
          { id: "box", name: "Second", host: "b.example" },
        ],
      },
    });
    expect(hosts).toHaveLength(1);
    expect(hosts[0]?.name).toBe("First");
  });
});

describe("custom agents", () => {
  function customDocument(entries: JsonValue[]): JsonObject {
    return normalize({ agents: { custom: entries } });
  }

  it("round-trips an entry with its defaults filled in", () => {
    const document = customDocument([
      {
        id: "custom:echo",
        label: "Echo",
        launchCmd: "/bin/echo",
        args: ["hello"],
        baseAgent: "codex",
      },
      { id: "custom:bare", label: "Bare", launchCmd: "wrapper" },
    ]);
    const agents = parseCustomAgents(document);
    expect(agents).toHaveLength(2);
    expect(agents[0]?.id).toBe("custom:echo");
    expect(agents[0]?.args).toEqual(["hello"]);
    expect(agents[0]?.baseAgent).toBe("codex");
    // Absent optionals get the documented defaults, not a missing key.
    expect(agents[1]?.baseAgent).toBe("claude");
    expect(agents[1]?.color).toBe("#a78bfa");
    expect(agents[1]?.args).toEqual([]);
    expect(at(document, "agents.custom")).toBeDefined();

    // A file that never had custom agents does not grow the section.
    expect(at(normalize({}), "agents")).toBeUndefined();
  });

  it("drops the unusable entries and collapses duplicates", () => {
    const document = customDocument([
      { id: "claude", label: "Not custom", launchCmd: "claude" },
      { id: "custom:ok", label: "First", launchCmd: "a" },
      { id: "custom:ok", label: "Duplicate", launchCmd: "b" },
      { id: "custom:no-name", label: "   ", launchCmd: "a" },
      { id: "custom:no-command", label: "Nameless", launchCmd: "" },
      { id: "custom:newline", label: "Sneaky", launchCmd: "a\nrm -rf /" },
      { id: "custom:bad id!", label: "Bad", launchCmd: "a" },
      {
        id: "custom:no-base",
        label: "Invented",
        launchCmd: "a",
        baseAgent: "invented",
      },
      "not an object",
    ]);
    const agents = parseCustomAgents(document);
    expect(agents).toHaveLength(1);
    expect(agents[0]?.label).toBe("First");
    expect(at(document, "agents.custom")).toHaveLength(1);
  });

  it("validates env keys and refuses to let the hook names be shadowed", () => {
    expect(validEnvKey("API_KEY")).toBe(true);
    expect(validEnvKey("_PRIVATE9")).toBe(true);
    expect(validEnvKey("9LIVES")).toBe(false);
    expect(validEnvKey("lower")).toBe(false);
    expect(validEnvKey("HAS-DASH")).toBe(false);
    expect(validEnvKey("")).toBe(false);
    // The hook client's own addressing is off limits: a custom agent must not
    // be able to redirect hook reports by shadowing it.
    expect(validEnvKey("ARMADRA_NODE_ID")).toBe(false);

    const long = "x".repeat(MAX_CUSTOM_ENV_VALUE + 1);
    const document = customDocument([
      {
        id: "custom:echo",
        label: "Echo",
        launchCmd: "e",
        env: {
          API_KEY: "k",
          ARMADRA_NODE_ID: "spoofed",
          "bad key": "x",
          TOO_LONG: long,
          NOT_A_STRING: 7,
        },
      },
    ]);
    const env = parseCustomAgents(document)[0]?.env ?? {};
    // An unusable key or an oversized value drops that variable, not the agent.
    expect(Object.keys(env)).toEqual(["API_KEY"]);
    expect(env.API_KEY).toBe("k");
  });

  it("accepts a built-in id and the custom shape, and nothing else", () => {
    expect(validAgentId("claude")).toBe(true);
    expect(validAgentId("custom:echo-1.2")).toBe(true);
    expect(validAgentId("custom:")).toBe(false);
    expect(validAgentId("custom:has space")).toBe(false);
    expect(validAgentId("invented")).toBe(false);
  });
});
