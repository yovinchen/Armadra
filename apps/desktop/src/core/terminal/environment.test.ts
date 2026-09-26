import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  INHERITED_ENV,
  agentEnvironment,
  agentPath,
  asRecord,
  childEnvironment,
  contextSessionEnvironment,
  defaultShell,
  inherited,
  setHookClient,
  withUtf8Locale,
} from "./environment";
import { parseProcessLine, processTable, processTree } from "./process";

describe("the inheritance allow-list", () => {
  /**
   * An allow-list, not a deny-list, and the difference is the whole point: the
   * core's own environment is whatever started it, and a shell under a tmux
   * server that inherited it would see another program's session variables for
   * as long as that server lives.
   */
  it("passes identity, locale and proxy variables and nothing else", () => {
    for (const name of INHERITED_ENV) expect(inherited(name)).toBe(true);
    expect(inherited("HTTP_PROXY")).toBe(true);
    expect(inherited("https_proxy")).toBe(true);
    expect(inherited("NO_PROXY")).toBe(true);
    expect(inherited("no_proxy")).toBe(true);

    expect(inherited("CLAUDECODE")).toBe(false);
    expect(inherited("TMUX")).toBe(false);
    expect(inherited("TMUX_PANE")).toBe(false);
    expect(inherited("ARMADRA_NODE_ID")).toBe(false);
    expect(inherited("PATH")).toBe(false);
  });

  it("builds a child environment rather than copying one", () => {
    const env = asRecord(
      childEnvironment({
        ambient: {
          HOME: "/home/tester",
          CLAUDECODE: "1",
          TMUX: "/tmp/tmux-0/default,1,0",
          HTTPS_PROXY: "http://proxy:8080",
          LANG: "en_US.UTF-8",
          PATH: "/usr/bin",
        },
      }),
    );
    expect(env.HOME).toBe("/home/tester");
    expect(env.HTTPS_PROXY).toBe("http://proxy:8080");
    expect(env.CLAUDECODE).toBeUndefined();
    expect(env.TMUX).toBeUndefined();
    expect(env.TERM).toBe("xterm-256color");
    expect(env.COLORTERM).toBe("truecolor");
    expect(env.PATH).toContain("/usr/bin");
  });
});

describe("the UTF-8 locale", () => {
  it("adds one when nothing inherited says UTF-8", () => {
    const env = asRecord(withUtf8Locale([], {}) as [string, string][]);
    expect(env.LANG).toBe("en_US.UTF-8");
    expect(env.LC_CTYPE).toBe("en_US.UTF-8");
  });

  it("leaves an inherited UTF-8 locale alone", () => {
    expect(withUtf8Locale([], { LANG: "zh_CN.UTF-8" })).toEqual([]);
    expect(withUtf8Locale([], { LC_ALL: "C.utf8" })).toEqual([]);
  });

  it("never overrides a caller's own choice", () => {
    const given = [["LANG", "C"]] as const;
    expect(withUtf8Locale(given, {})).toEqual(given);
  });
});

describe("the agent PATH", () => {
  it("appends rather than prepends, so a user's own tool still wins", () => {
    const path = agentPath({ PATH: "/usr/bin:/bin" });
    expect(path.startsWith("/usr/bin:/bin")).toBe(true);
  });

  it("adds nothing twice", () => {
    const path = agentPath({ PATH: "/usr/bin:/usr/bin" });
    const seen = new Set<string>();
    for (const entry of path.split(":")) {
      if (entry === "/usr/bin") continue;
      expect(seen.has(entry)).toBe(false);
      seen.add(entry);
    }
  });
});

describe("agent injection", () => {
  /**
   * Contract §5 item 5: six variables, and the per-node token is not one of
   * them. Any process of the same user can read another process' environment.
   */
  it("injects four addresses at creation and no credential", () => {
    const env = agentEnvironment("node-1", "claude", "/data");
    expect(env.map(([key]) => key)).toEqual([
      "ARMADRA_NODE_ID",
      "ARMADRA_AGENT_ID",
      "ARMADRA_ENDPOINT_FILE",
      "ARMADRA_CANVAS_CONTROL",
    ]);
    expect(asRecord(env).ARMADRA_ENDPOINT_FILE).toBe(
      join("/data", "hook-endpoint.env"),
    );
    for (const [key, value] of env) {
      expect(key).not.toMatch(/TOKEN|SECRET|PASSWORD/i);
      expect(value).not.toMatch(/TOKEN|SECRET/i);
    }
  });

  /**
   * 设计 §2.4：模型得能不问就答出「我对别人叫什么」。没起名的节点这个变量不
   * 存在，而不是空串——空串会让一条 `if [ -n ... ]` 与「叫空字符串」分不开。
   */
  it("adds the node's name when it has one, and nothing when it does not", () => {
    expect(
      asRecord(agentEnvironment("node-1", "claude", "/data", "reviewer"))
        .ARMADRA_NODE_NAME,
    ).toBe("reviewer");
    for (const absent of [undefined, ""]) {
      const env = agentEnvironment("node-1", "claude", "/data", absent);
      expect(env.map(([key]) => key)).not.toContain("ARMADRA_NODE_NAME");
    }
  });

  it("adds the session pair, and only for a terminal that has a node", () => {
    const withNode = contextSessionEnvironment(
      agentEnvironment("node-1", "claude", "/data"),
      "session-1",
      2,
    );
    const record = asRecord(withNode);
    expect(record.ARMADRA_SESSION_ID).toBe("session-1");
    expect(record.ARMADRA_SESSION_GENERATION).toBe("2");
    expect(Object.keys(record)).toHaveLength(6);

    // No node: nothing to attribute a report to, so nothing is injected.
    expect(contextSessionEnvironment([], "session-1", 2)).toEqual([]);
  });

  it("replaces the pair on a recycle instead of appending a second one", () => {
    const first = contextSessionEnvironment(
      agentEnvironment("node-1", "claude", "/data"),
      "session-1",
      1,
    );
    const second = contextSessionEnvironment(first, "session-1", 2);
    expect(
      second.filter(([key]) => key === "ARMADRA_SESSION_GENERATION"),
    ).toHaveLength(1);
    expect(asRecord(second).ARMADRA_SESSION_GENERATION).toBe("2");
  });

  it("starts the terminal even when the telemetry sequence cannot be set up", () => {
    const env = contextSessionEnvironment(
      agentEnvironment("node-1", "claude", "/data"),
      "session-1",
      1,
      () => false,
    );
    expect(asRecord(env).ARMADRA_SESSION_ID).toBeUndefined();
    expect(asRecord(env).ARMADRA_NODE_ID).toBe("node-1");
  });
});

describe("the default shell", () => {
  it("follows SHELL on unix and COMSPEC on Windows", () => {
    expect(defaultShell({ SHELL: "/bin/zsh" }, "darwin")).toBe("/bin/zsh");
    expect(defaultShell({}, "linux")).toBe("/bin/sh");
    expect(defaultShell({ COMSPEC: "C:\\cmd.exe" }, "win32")).toBe(
      "C:\\cmd.exe",
    );
  });

  it("prefers PowerShell 7 over Windows PowerShell 5.1 without COMSPEC", () => {
    const path = "C:\\Windows\\System32;C:\\Program Files\\PowerShell\\7\\";
    const pwsh = "C:\\Program Files\\PowerShell\\7\\pwsh.exe";
    expect(defaultShell({ Path: path }, "win32", (file) => file === pwsh)).toBe(
      pwsh,
    );
    expect(defaultShell({ Path: path }, "win32", () => false)).toBe(
      "powershell.exe",
    );
    // COMSPEC 仍然优先：它就是系统说的缺省 shell。
    expect(
      defaultShell({ COMSPEC: "C:\\cmd.exe", Path: path }, "win32", () => true),
    ).toBe("C:\\cmd.exe");
  });
});

describe("the process table", () => {
  /**
   * The exact column layout `ps -Ao pid=,ppid=,args=` produces on macOS and
   * Linux: both numbers right-aligned, so the gap between them varies with the
   * number of digits. Splitting on a single whitespace character would drop
   * every line whose parent is not the same width, which is silent and total.
   */
  it("parses whatever the pid width is", () => {
    expect(parseProcessLine("    1     0 /sbin/launchd")).toEqual([
      1,
      0,
      "/sbin/launchd",
    ]);
    expect(
      parseProcessLine(
        "10229     1 /Applications/Some.app/Contents/MacOS/Some",
      ),
    ).toEqual([10229, 1, "/Applications/Some.app/Contents/MacOS/Some"]);
    expect(parseProcessLine(" 1733  4794 /bin/sh -c echo hello world")).toEqual(
      [1733, 4794, "/bin/sh -c echo hello world"],
    );
    // A header or a partial line must not become a process.
    expect(parseProcessLine("garbage")).toBeUndefined();
    expect(parseProcessLine("")).toBeUndefined();
  });

  it.skipIf(process.platform === "win32")("walks a real tree", () => {
    const table = processTable();
    expect(table.has(process.pid)).toBe(true);
    // Anything but a nearly-empty table: the parse bug this guards against
    // leaves exactly the rows whose parent happened to be the right width.
    expect(table.size).toBeGreaterThan(20);
    expect(processTree(process.pid, table)).toContain(process.pid);
  });
});

/**
 * The hook client every canvas terminal has to be able to reach.
 *
 * The skill tells the model to run `armadra-hook` by name and to fall back to
 * the absolute path in `ARMADRA_HOOK_BIN` when a shell profile has rewritten
 * PATH. Neither was ever set, so the command was not found in any canvas
 * terminal and no agent could reach any of the three verb families.
 */
describe("the armadra-hook client in a child environment", () => {
  const ambient = { HOME: "/home/tester", PATH: "/usr/bin" };

  it("is absent entirely when no bundle was found", () => {
    setHookClient(undefined);
    const env = asRecord(childEnvironment({ ambient }));
    // Absent, not empty: the fallback must never name a path that resolves to
    // nothing.
    expect(env.ARMADRA_HOOK_BIN).toBeUndefined();
  });

  it("names the client and puts its directory last on PATH", () => {
    const directory = mkdtempSync(join(tmpdir(), "armadra-hookbin-"));
    const client = join(directory, "armadra-hook");
    writeFileSync(client, "#!/bin/sh\n", "utf8");
    try {
      setHookClient(client);
      const env = asRecord(childEnvironment({ ambient }));
      expect(env.ARMADRA_HOOK_BIN).toBe(client);
      // Appended, never prepended: a tool of the user's with the same name
      // still wins.
      expect(env.PATH?.split(delimiter).at(-1)).toBe(directory);
      expect(env.PATH?.startsWith("/usr/bin")).toBe(true);
    } finally {
      setHookClient(undefined);
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("lets an explicit option win over the published one", () => {
    setHookClient("/published/armadra-hook");
    try {
      const env = asRecord(
        childEnvironment({ ambient, hookBin: "/explicit/armadra-hook" }),
      );
      expect(env.ARMADRA_HOOK_BIN).toBe("/explicit/armadra-hook");
    } finally {
      setHookClient(undefined);
    }
  });
});
