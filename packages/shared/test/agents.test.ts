import { describe, expect, it } from "vitest";
import {
  AGENT_IDS,
  AGENT_LIST,
  AGENT_REGISTRY,
  CLAUDE_HOOK_EVENTS,
  HOOK_CLIENT_REVISION,
  HOOK_EVENTS,
  PERMISSION_MODES,
  assembleLaunchArgv,
  assembleLaunchCommand,
  collapsePrompt,
  customAgentSchema,
  hookEventsFor,
  inheritedAgentCapabilities,
  isAgentId,
  shellQuote,
} from "../src/index.js";

describe("agent registry", () => {
  it("custom capabilities can only narrow a real base adapter", () => {
    expect(() => assembleLaunchCommand({ agentId: "custom:missing" })).toThrow(
      /Unknown agent/,
    );
    const custom = customAgentSchema.parse({
      id: "custom:narrow",
      label: "Narrow",
      launchCmd: "wrapper",
      baseAgent: "claude",
      disabledCapabilities: ["resume", "usage"],
    });
    expect(inheritedAgentCapabilities(custom)).not.toContain("resume");
    expect(inheritedAgentCapabilities(custom)).not.toContain("usage");
    expect(inheritedAgentCapabilities(custom)).toContain("hooks");
    expect(() =>
      assembleLaunchCommand({
        agentId: custom.id,
        custom,
        resume: "provider-session",
      }),
    ).toThrow(/resume is disabled/);
    expect(
      assembleLaunchCommand({ agentId: custom.id, custom, prompt: "hello" })
        .command,
    ).toContain("hello");
    expect(
      customAgentSchema.safeParse({
        ...custom,
        disabledCapabilities: ["invented"],
      }).success,
    ).toBe(false);
    expect(
      customAgentSchema.safeParse({ ...custom, baseAgent: "invented" }).success,
    ).toBe(false);
    // A base adapter that has the capability keeps it; disabling is the only
    // direction a custom entry may move it.
    expect(
      inheritedAgentCapabilities({
        baseAgent: "codex",
        disabledCapabilities: [],
      }),
    ).toContain("subagent");
    expect(
      inheritedAgentCapabilities({
        baseAgent: "codex",
        disabledCapabilities: ["subagent"],
      }),
    ).not.toContain("subagent");
    // …and one the base adapter never declared stays absent either way.
    expect(
      inheritedAgentCapabilities({
        baseAgent: "codex",
        disabledCapabilities: [],
      }),
    ).not.toContain("nativeRecurrence");
  });
  it("covers the six built-in CLIs with a full permission table", () => {
    expect(AGENT_IDS).toEqual([
      "claude",
      "codex",
      "opencode",
      "pi",
      "omp",
      "copilot",
    ]);
    expect(AGENT_LIST).toHaveLength(6);
    for (const agent of AGENT_LIST) {
      expect(agent.launchCmd.length).toBeGreaterThan(0);
      expect(agent.color).toMatch(/^#[0-9a-f]{6}$/);
      expect(agent.expectedProcess.length).toBeGreaterThan(0);
      expect(agent.capabilities).toContain("contextLink");
      // B01: the browser verb rides the same channel as the context link, so
      // every adapter that has one declares both.
      expect(agent.capabilities).toContain("browser");
      for (const mode of PERMISSION_MODES) {
        expect(Array.isArray(agent.permissionFlag[mode])).toBe(true);
      }
    }
    expect(AGENT_REGISTRY.opencode.promptFlag).toBeDefined();
    expect(AGENT_REGISTRY.claude.sessionIdFlag).toBe("--session-id");
  });

  it("recognises built-in ids only", () => {
    expect(isAgentId("claude")).toBe(true);
    expect(isAgentId("custom:abc")).toBe(false);
    expect(isAgentId(42)).toBe(false);
  });

  it("validates custom agents", () => {
    const parsed = customAgentSchema.parse({
      id: "custom:my-cli",
      label: "My CLI",
      launchCmd: "my-cli",
    });
    expect(parsed.baseAgent).toBe("claude");
    expect(
      customAgentSchema.safeParse({ id: "my-cli", label: "x", launchCmd: "y" })
        .success,
    ).toBe(false);
  });
});

describe("hook events", () => {
  it("lists every provider's event names exactly once", () => {
    expect(HOOK_CLIENT_REVISION).toBe(4);
    for (const id of AGENT_IDS) {
      const events = hookEventsFor(id);
      expect(events.length > 0).toBe(
        AGENT_REGISTRY[id].capabilities.includes("hooks"),
      );
      expect(new Set(events).size).toBe(events.length);
      expect(HOOK_EVENTS[id]).toBe(events);
    }
    expect(CLAUDE_HOOK_EVENTS).toContain("PermissionRequest");
    expect(CLAUDE_HOOK_EVENTS).toContain("SubagentStop");
    expect(HOOK_EVENTS.opencode).toContain("session.idle");
    // Codex has no Notification event; the installer skipped it on every run.
    expect(HOOK_EVENTS.codex).not.toContain("Notification");
  });

  // Pi documents `agent_settled` as the event a status integration should use,
  // and it is the only one of Pi's that says the CLI is idle rather than
  // between two of its own steps. Without it the idle gate has nothing to read
  // and handoff delivery stays refused.
  it("subscribes the events each new adapter's state actually comes from", () => {
    expect(HOOK_EVENTS.pi).toContain("agent_settled");
    expect(HOOK_EVENTS.omp).toContain("agent_settled");
    // OMP is a fork with its own settle and compaction events, so its list is
    // not Pi's: 18.1.8 emits `session_stop` where Pi emits `agent_settled`,
    // and losing it would leave that CLI with no idle evidence at all.
    expect(HOOK_EVENTS.omp).toContain("session_stop");
    expect(HOOK_EVENTS.pi).not.toContain("session_stop");
    expect(HOOK_EVENTS.omp).toContain("auto_compaction_end");
    expect(HOOK_EVENTS.pi).not.toContain("auto_compaction_end");
    expect(HOOK_EVENTS.copilot).toContain("agentStop");
  });

  // Copilot reads a non-zero exit or a crash on `preToolUse` as a denial. A
  // missing binary or a moved path would then refuse every tool call, on a
  // channel whose whole contract is that it fails open.
  it("never subscribes Copilot's one blocking event", () => {
    expect(HOOK_EVENTS.copilot).not.toContain("preToolUse");
  });
});

describe("assembleLaunchCommand", () => {
  it("puts the prompt on argv for claude and codex", () => {
    expect(
      assembleLaunchCommand({ agentId: "claude", prompt: "fix the build" }),
    ).toEqual({ command: "claude 'fix the build'" });
    expect(
      assembleLaunchCommand({ agentId: "codex", prompt: "hello" }),
    ).toEqual({ command: "codex hello" });
  });

  it("uses OpenCode’s supported interactive prompt flag", () => {
    expect(
      assembleLaunchCommand({ agentId: "opencode", prompt: "run the tests" }),
    ).toEqual({ command: "opencode --prompt 'run the tests'" });
  });

  it("orders permission mode, model and session id before the prompt", () => {
    expect(
      assembleLaunchCommand({
        agentId: "claude",
        permissionMode: "plan",
        model: "opus",
        sessionId: "019ff7d1-5c48-7d75-a0ed-64b52f44e214",
        prompt: "go",
      }).command,
    ).toBe(
      "claude --permission-mode plan --model opus --session-id 019ff7d1-5c48-7d75-a0ed-64b52f44e214 go",
    );
    expect(
      assembleLaunchCommand({ agentId: "claude", permissionMode: "full-auto" })
        .command,
    ).toBe("claude --dangerously-skip-permissions");
    expect(
      assembleLaunchCommand({ agentId: "codex", permissionMode: "auto-edit" })
        .command,
    ).toBe("codex --full-auto");
  });

  it("ignores a session id flag the CLI does not have", () => {
    expect(
      assembleLaunchCommand({ agentId: "opencode", sessionId: "abc" }).command,
    ).toBe("opencode");
  });

  it("honours a program override and extra args", () => {
    expect(
      assembleLaunchCommand({
        agentId: "custom:mine",
        baseAgent: "claude",
        programOverride: "/opt/my tools/claude",
        extraArgs: ["--flag", "value with space"],
        prompt: "hi",
      }).command,
    ).toBe("'/opt/my tools/claude' --flag 'value with space' hi");
  });

  it("collapses a multi-line prompt into one shell-safe line", () => {
    const { command } = assembleLaunchCommand({
      agentId: "claude",
      prompt: "line one\nline two\ttabbed\r\n  spaced  ",
    });
    expect(command).toBe("claude 'line one line two tabbed spaced'");
    expect(command).not.toContain("\n");
  });

  it("escapes single quotes the POSIX way", () => {
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
    expect(shellQuote("plain-value_1.2/3")).toBe("plain-value_1.2/3");
    expect(shellQuote("")).toBe("''");
    expect(
      assembleLaunchCommand({ agentId: "claude", prompt: "don't `rm -rf /`" })
        .command,
    ).toBe(`claude 'don'\\''t \`rm -rf /\`'`);
    expect(collapsePrompt("a\u0000b")).toBe("a b");
  });

  it("rejects unknown agents", () => {
    expect(() => assembleLaunchCommand({ agentId: "nope" })).toThrow(
      /Unknown agent id/,
    );
  });
});

describe("resuming a conversation", () => {
  it("puts codex's resume verb ahead of every flag", () => {
    // `codex resume <id> --sandbox read-only` parses; a subcommand after a
    // flag does not, which is why resume is emitted first.
    const { command } = assembleLaunchCommand({
      agentId: "codex",
      resume: "019edf45-4c81-7d30-a950-9d7a7cc853c7",
      permissionMode: "plan",
      model: "gpt-5",
    });
    expect(command).toBe(
      "codex resume 019edf45-4c81-7d30-a950-9d7a7cc853c7 --sandbox read-only --model gpt-5",
    );
  });

  it("uses --resume for claude and copilot", () => {
    expect(
      assembleLaunchCommand({ agentId: "claude", resume: "abc-123" }).command,
    ).toBe("claude --resume abc-123");
    expect(
      assembleLaunchCommand({
        agentId: "copilot",
        resume: "abc-123",
        prompt: "carry on",
      }).command,
    ).toBe("copilot --resume abc-123 --interactive 'carry on'");
  });

  it("resumes OpenCode via its session flag", () => {
    expect(
      assembleLaunchCommand({
        agentId: "opencode",
        resume: "abc-123",
        prompt: "hello",
      }),
    ).toEqual({
      command: "opencode --session abc-123 --prompt hello",
    });
  });

  it("advertises resume exactly where the launch line supports it", () => {
    for (const agent of AGENT_LIST) {
      expect(agent.capabilities.includes("resume")).toBe(
        agent.resume !== undefined,
      );
    }
  });

  it("wins over a pre-minted session id and survives quoting", () => {
    // `--session-id` mints a new session; claude rejects the pair outright.
    const { command } = assembleLaunchCommand({
      agentId: "claude",
      resume: "abc 123",
      sessionId: "should-not-appear",
    });
    expect(command).toBe("claude --resume 'abc 123'");
    expect(command).not.toContain("--session-id");
  });

  it("ignores a blank resume id", () => {
    expect(
      assembleLaunchCommand({ agentId: "claude", resume: "   " }).command,
    ).toBe("claude");
  });

  it("resumes through a custom agent's base adapter", () => {
    expect(
      assembleLaunchCommand({
        agentId: "custom:mine",
        baseAgent: "codex",
        programOverride: "/opt/bin/mycodex",
        resume: "abc-123",
      }).command,
    ).toBe("/opt/bin/mycodex resume abc-123");
  });
});

describe("自定义 Agent", () => {
  const echo = customAgentSchema.parse({
    id: "custom:echo",
    label: "Echo",
    launchCmd: "/bin/echo",
    args: ["hello", "two words"],
    baseAgent: "claude",
    env: { API_KEY: "k" },
  });

  it("fills in the defaults and refuses the reserved env names", () => {
    expect(echo.color).toBe("#a78bfa");
    expect(echo.baseAgent).toBe("claude");
    expect(
      customAgentSchema.safeParse({ id: "nope", label: "x", launchCmd: "x" })
        .success,
    ).toBe(false);
    // `ARMADRA_*` belongs to the hook client; a custom agent may not set it.
    for (const key of ["ARMADRA_NODE_ID", "lower", "9LIVES", "HAS-DASH"]) {
      expect(
        customAgentSchema.safeParse({ ...echo, env: { [key]: "v" } }).success,
      ).toBe(false);
    }
  });

  it("launches the custom program with its own args before the prompt", () => {
    const { command } = assembleLaunchCommand({
      agentId: "custom:echo",
      custom: echo,
      permissionMode: "plan",
      prompt: "go",
    });
    // Base agent flags, then the entry's argv, then the prompt.
    expect(command).toBe(
      "/bin/echo --permission-mode plan hello 'two words' go",
    );
  });

  it("takes the prompt mode and the flags from the base agent", () => {
    const copilot = { ...echo, baseAgent: "copilot" as const };
    expect(
      assembleLaunchCommand({
        agentId: "custom:echo",
        custom: copilot,
        prompt: "go",
      }).command,
    ).toContain("--interactive go");

    const opencode = { ...echo, baseAgent: "opencode" as const, args: [] };
    const launch = assembleLaunchCommand({
      agentId: "custom:echo",
      custom: opencode,
      prompt: "go",
    });
    expect(launch.command).toBe("/bin/echo --prompt go");
    expect(launch.stdinPrompt).toBeUndefined();
  });

  it("never puts the environment on the launch line", () => {
    // The runtime merges `env` into the PTY; a `VAR=value` prefix here would
    // land in the user's shell history.
    const { command } = assembleLaunchCommand({
      agentId: "custom:echo",
      custom: echo,
    });
    expect(command).not.toContain("API_KEY");
  });

  it("still honours a launch-command override and extra args", () => {
    const { command } = assembleLaunchCommand({
      agentId: "custom:echo",
      custom: echo,
      programOverride: "/opt/wrapper",
      extraArgs: ["--late"],
    });
    expect(command).toBe("/opt/wrapper hello 'two words' --late");
  });
});

describe("additional interactive CLIs", () => {
  it("uses real provider resume and prompt flags without noninteractive switches", () => {
    expect(
      assembleLaunchCommand({
        agentId: "pi",
        resume: "session.jsonl",
        prompt: "review",
      }).command,
    ).toBe("pi --session session.jsonl review");
    expect(
      assembleLaunchCommand({
        agentId: "omp",
        resume: "123",
        model: "opus",
        permissionMode: "auto-edit",
      }).command,
    ).toBe("omp --resume 123 --approval-mode write --model opus");
    expect(
      assembleLaunchCommand({
        agentId: "copilot",
        resume: "123",
        prompt: "review",
        permissionMode: "plan",
      }).command,
    ).toBe("copilot --resume 123 --plan --interactive review");
  });
  it("honors an explicit custom stdin prompt mode", () => {
    const custom = customAgentSchema.parse({
      id: "custom:local",
      label: "Local",
      launchCmd: "local-cli",
      baseAgent: "pi",
      promptMode: "stdin-after-start",
    });
    expect(
      assembleLaunchCommand({ agentId: custom.id, custom, prompt: "hello" }),
    ).toEqual({ command: "local-cli", stdinPrompt: "hello" });
  });
});

describe("unsupported permission modes", () => {
  it("never silently starts an unrestricted Pi/OMP/OpenCode session when plan was requested", () => {
    for (const agentId of ["pi", "omp", "opencode"]) {
      expect(() =>
        assembleLaunchCommand({ agentId, permissionMode: "plan" }),
      ).toThrow(/does not support permission mode/);
    }
  });
});

describe("assembleLaunchArgv", () => {
  it("returns the values a CLI receives, not the shell text around them", () => {
    const argv = assembleLaunchArgv({
      agentId: "claude",
      permissionMode: "plan",
      model: "sonnet",
    });
    expect(argv.program).toBe("claude");
    // Nothing here is quoted: quoting belongs to writing into a shell, and a
    // frozen plan that stored quotes would pass them to the CLI verbatim.
    expect(argv.args.some((arg) => arg.includes("'"))).toBe(false);
    expect(argv.args).toContain("sonnet");
  });

  it("agrees with the shell line it is quoted into", () => {
    const input = {
      agentId: "claude",
      permissionMode: "auto-edit" as const,
      model: "a model",
    };
    const argv = assembleLaunchArgv(input);
    expect(assembleLaunchCommand(input).command).toBe(
      [argv.program, ...argv.args]
        .map((part) =>
          /^[A-Za-z0-9_@%+=:,./-]+$/.test(part) ? part : `'${part}'`,
        )
        .join(" "),
    );
  });

  it("keeps a stdin prompt out of the argv, exactly as the shell line does", () => {
    const custom = customAgentSchema.parse({
      id: "custom:local",
      label: "Local",
      launchCmd: "local-cli",
      baseAgent: "pi",
      promptMode: "stdin-after-start",
    });
    const argv = assembleLaunchArgv({
      agentId: custom.id,
      custom,
      prompt: "hello",
    });
    expect(argv.args).toEqual([]);
    expect(argv.stdinPrompt).toBe("hello");
  });
});

describe("the typed canvas injection", () => {
  it("appends the runtime's words verbatim, in front of a prompt", () => {
    expect(
      assembleLaunchCommand({
        agentId: "codex",
        shellWords: [
          "-c",
          { prefix: "hooks.Stop=", env: "ARMADRA_CODEX_HOOK" },
        ],
      }).command,
    ).toBe('codex -c "hooks.Stop=${ARMADRA_CODEX_HOOK}"');
    expect(
      assembleLaunchCommand({
        agentId: "codex",
        programOverride: "C:\\Program Files\\codex.exe",
        shellWords: [
          "-c",
          { prefix: "hooks.Stop=", env: "ARMADRA_CODEX_HOOK" },
        ],
        dialect: "powershell",
      }).command,
    ).toBe(
      "& 'C:\\Program Files\\codex.exe' -c \"hooks.Stop=${env:ARMADRA_CODEX_HOOK}\"",
    );
    expect(
      assembleLaunchCommand({
        agentId: "codex",
        programOverride: "C:\\Program Files\\codex.exe",
        shellWords: [
          "-c",
          { prefix: "hooks.Stop=", env: "ARMADRA_CODEX_HOOK" },
        ],
        dialect: "cmd",
      }).command,
    ).toBe(
      '"C:\\Program Files\\codex.exe" -c "hooks.Stop=%ARMADRA_CODEX_HOOK%"',
    );
    expect(
      assembleLaunchCommand({
        agentId: "claude",
        shellWords: ["--settings", "/d/s.json"],
        prompt: "hi there",
      }).command,
    ).toBe("claude --settings /d/s.json 'hi there'");
    expect(
      assembleLaunchCommand({
        agentId: "copilot",
        shellWords: ["--plugin-dir", "/d/p"],
        prompt: "go",
      }).command,
    ).toBe("copilot --plugin-dir /d/p --interactive go");
  });

  it("never puts them into a frozen argv", () => {
    expect(
      assembleLaunchArgv({ agentId: "codex", shellWords: ["-c", "x"] }).args,
    ).toEqual([]);
  });
});
