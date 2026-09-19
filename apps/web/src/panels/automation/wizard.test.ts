import {
  AutomationColdStartPolicy,
  AutomationConcurrencyPolicy,
  AutomationMisfirePolicy,
  AutomationTargetKind,
} from "../../api/automations";
import { describe, expect, it } from "vitest";

import {
  buildLaunchSpec,
  buildPlanConfig,
  defaultWizardState,
  localInput,
  targetFromConfig,
  wizardStateFromConfig,
  type WizardState,
  type WizardTarget,
} from "./wizard";

const target: WizardTarget = {
  kind: "command",
  workspaceId: "workspace-1",
  executionHostId: "0123456789abcdef0123456789abcdef",
  sessionId: "session-1",
  generation: 3n,
};

function form(overrides: Partial<WizardState> = {}): WizardState {
  return {
    ...defaultWizardState(Date.parse("2026-09-05T12:00:00Z")),
    title: "每晚构建",
    ...overrides,
  };
}

function built(overrides: Partial<WizardState> = {}) {
  const result = buildPlanConfig(form(overrides), target);
  if (!result.ok) throw new Error(`unexpected refusal: ${result.messageKey}`);
  return result.config;
}

describe("plan configuration", () => {
  it("binds the plan to this workspace, Host and frozen generation", () => {
    const config = built();
    expect(config.workspaceId).toBe("workspace-1");
    expect(config.target?.executionHostId).toBe(target.executionHostId);
    expect(config.target?.sessionId).toBe("session-1");
    expect(config.target?.generation).toBe(3n);
  });

  it("builds each schedule shape", () => {
    expect(built().schedule?.kind?.case).toBe("once");
    expect(built({ scheduleKind: "interval" }).schedule?.kind?.case).toBe(
      "interval",
    );
    const cron = built({ scheduleKind: "cron", timezone: "Asia/Shanghai" });
    expect(cron.schedule?.kind?.case).toBe("cron");
    expect(
      cron.schedule?.kind?.case === "cron" && cron.schedule.kind.value.timezone,
    ).toBe("Asia/Shanghai");
    const loop = built({ scheduleKind: "loop", maxRuns: "5" });
    expect(loop.schedule?.kind?.case).toBe("loopAfterCompletion");
    expect(loop.maxRuns).toBe(5n);
  });

  it("stores the chosen zone rather than inferring the device's", () => {
    const config = built({
      scheduleKind: "cron",
      cron: "0 3 * * *",
      timezone: "Europe/Berlin",
    });
    expect(
      config.schedule?.kind?.case === "cron" &&
        config.schedule.kind.value.timezone,
    ).toBe("Europe/Berlin");
  });

  it("normalizes whitespace inside a cron expression", () => {
    const config = built({ scheduleKind: "cron", cron: "  0   3 * * *  " });
    expect(
      config.schedule?.kind?.case === "cron" &&
        config.schedule.kind.value.expression,
    ).toBe("0 3 * * *");
  });

  it("refuses an unbounded loop", () => {
    const unbounded = buildPlanConfig(
      form({ scheduleKind: "loop", maxRuns: "", expiresAt: "" }),
      target,
    );
    expect(unbounded).toMatchObject({
      ok: false,
      messageKey: "automation.wizard.loopBound",
    });
    // Either bound is enough on its own.
    expect(
      buildPlanConfig(form({ scheduleKind: "loop", maxRuns: "3" }), target).ok,
    ).toBe(true);
    expect(
      buildPlanConfig(
        form({ scheduleKind: "loop", expiresAt: "2027-01-01T00:00" }),
        target,
      ).ok,
    ).toBe(true);
  });

  it("refuses a cron expression or zone the Host would reject", () => {
    expect(
      buildPlanConfig(form({ scheduleKind: "cron", cron: "0 3 * *" }), target),
    ).toMatchObject({ messageKey: "automation.wizard.invalidCron" });
    expect(
      buildPlanConfig(
        form({ scheduleKind: "cron", timezone: "Mars/Olympus" }),
        target,
      ),
    ).toMatchObject({ messageKey: "automation.wizard.invalidTimezone" });
    // "Local" is refused by the Host; the panel must not offer it either.
    expect(
      buildPlanConfig(form({ scheduleKind: "cron", timezone: "" }), target),
    ).toMatchObject({ messageKey: "automation.wizard.invalidTimezone" });
  });

  it("keeps periods inside the Host's own bounds", () => {
    for (const intervalMs of ["0", "999", "31536000001", "-1", "1e3", ""])
      expect(
        buildPlanConfig(form({ scheduleKind: "interval", intervalMs }), target),
        intervalMs,
      ).toMatchObject({ messageKey: "automation.wizard.invalidInterval" });
    expect(buildPlanConfig(form({ busyTtlMs: "999" }), target)).toMatchObject({
      messageKey: "automation.wizard.invalidInterval",
    });
    expect(
      buildPlanConfig(form({ busyTtlMs: "86400001" }), target),
    ).toMatchObject({ messageKey: "automation.wizard.invalidInterval" });
  });

  it("requires a name and a target session", () => {
    expect(buildPlanConfig(form({ title: "   " }), target).ok).toBe(false);
    expect(buildPlanConfig(form(), { ...target, sessionId: "" })).toMatchObject(
      { field: "session" },
    );
  });

  it("maps the policy choices onto their enum values", () => {
    expect(built({ misfire: "skip" }).misfirePolicy).toBe(
      AutomationMisfirePolicy.SKIP,
    );
    expect(built({ misfire: "coalesce" }).misfirePolicy).toBe(
      AutomationMisfirePolicy.COALESCE_ONE,
    );
    expect(built({ concurrency: "forbid" }).concurrencyPolicy).toBe(
      AutomationConcurrencyPolicy.FORBID,
    );
    expect(built({ concurrency: "queue" }).concurrencyPolicy).toBe(
      AutomationConcurrencyPolicy.QUEUE_ONE,
    );
  });

  it("leaves the payload digest to the Host", () => {
    const config = built();
    expect(config.payloadRef).toBe("");
    expect(config.payloadSha256.byteLength).toBe(0);
  });
});

describe("command launch spec", () => {
  it("freezes an absolute executable and one argument per line", () => {
    const spec = buildLaunchSpec({
      executable: " /bin/echo ",
      args: "--flag\n  值  \n\n",
      timeoutMs: "60000",
    });
    expect(spec).toMatchObject({
      executable: "/bin/echo",
      args: ["--flag", "值"],
      workingDirectory: ".",
      accountId: "default",
      timeoutMs: 60000n,
    });
  });

  it("refuses a relative path, an embedded argument or a bad timeout", () => {
    expect(
      buildLaunchSpec({ executable: "echo", args: "", timeoutMs: "1000" }),
    ).toMatchObject({ messageKey: "automation.wizard.invalidPath" });
    expect(
      buildLaunchSpec({
        executable: "/bin/echo --flag",
        args: "",
        timeoutMs: "1000",
      }),
    ).toMatchObject({ messageKey: "automation.wizard.invalidPath" });
    expect(
      buildLaunchSpec({ executable: "/bin/echo", args: "", timeoutMs: "0" }),
    ).toMatchObject({ messageKey: "automation.wizard.invalidInterval" });
  });
});

describe("datetime inputs", () => {
  it("round-trips a local datetime value", () => {
    const now = Date.parse("2026-09-05T12:34:00Z");
    const value = localInput(now);
    expect(value).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
    expect(Date.parse(value)).toBe(now - (now % 60_000));
  });

  it("starts a once plan in the future, not at the current instant", () => {
    const now = Date.parse("2026-09-05T12:00:00Z");
    expect(Date.parse(defaultWizardState(now).at)).toBeGreaterThan(now);
  });
});

describe("agent terminal targets", () => {
  const agentTarget: WizardTarget = {
    kind: "agent",
    workspaceId: "workspace-1",
    executionHostId: "0123456789abcdef0123456789abcdef",
    sessionId: "session-1",
    generation: 3n,
    nodeId: "9f1d0f66-0f7b-7c1f-9a2c-2f7b0f7c1f9a",
    agentLaunch: {
      agentId: "claude",
      workingDirectory: ".",
      args: ["--permission-mode", "plan"],
      permissionMode: "plan",
      modelId: "",
      accountId: "default",
    },
    coldStart: false,
  };

  function agentConfig(overrides: Partial<WizardState> = {}) {
    const result = buildPlanConfig(
      form({ payload: "每晚复盘", ...overrides }),
      agentTarget,
    );
    if (!result.ok) throw new Error(`unexpected refusal: ${result.messageKey}`);
    return result.config;
  }

  it("freezes the node and the launch definition the executor re-checks", () => {
    const target = agentConfig().target!;
    expect(target.kind).toBe(AutomationTargetKind.AGENT_SESSION_PROMPT);
    expect(target.nodeId).toBe(agentTarget.nodeId);
    expect(target.agentLaunch?.args).toEqual(["--permission-mode", "plan"]);
    // The definition names no executable: the program is resolved from the
    // agent id by whatever runs it, so a stored plan cannot become "run this".
    expect(Object.keys(target.agentLaunch ?? {})).not.toContain("executable");
  });

  it("only carries the permission to launch when it was asked for", () => {
    expect(agentConfig().target?.coldStartPolicy).toBe(
      AutomationColdStartPolicy.SKIP,
    );
    const warm = buildPlanConfig(form({ payload: "每晚复盘" }), {
      ...agentTarget,
      coldStart: true,
    });
    expect(warm.ok && warm.config.target?.coldStartPolicy).toBe(
      AutomationColdStartPolicy.LAUNCH_FROZEN,
    );
  });

  it("refuses a plan that would type nothing into somebody's terminal", () => {
    const result = buildPlanConfig(form({ payload: "  \n " }), agentTarget);
    expect(result).toMatchObject({
      ok: false,
      field: "payload",
      messageKey: "automation.wizard.promptRequired",
    });
  });

  it("leaves a command plan free of any agent identity", () => {
    const config = built();
    expect(config.target?.kind).toBe(
      AutomationTargetKind.NON_INTERACTIVE_COMMAND,
    );
    expect(config.target?.nodeId).toBe("");
    expect(config.target?.agentLaunch).toBeUndefined();
    expect(config.target?.coldStartPolicy).toBe(AutomationColdStartPolicy.SKIP);
  });
});

/**
 * Editing a plan re-sends its whole configuration, so the form has to be able
 * to reproduce what is stored. Anything this round trip drops would be saved
 * as if the user had changed it.
 */
describe("editing an existing plan", () => {
  const agentTarget: WizardTarget = {
    kind: "agent",
    workspaceId: "workspace-1",
    executionHostId: "0123456789abcdef0123456789abcdef",
    sessionId: "session-1",
    generation: 3n,
    nodeId: "9f1d0f66-0f7b-7c1f-9a2c-2f7b0f7c1f9a",
    agentLaunch: {
      agentId: "claude",
      workingDirectory: ".",
      args: ["--permission-mode", "plan"],
      permissionMode: "plan",
      modelId: "",
      accountId: "default",
    },
    coldStart: false,
  };

  const roundTrip = (overrides: Partial<WizardState> = {}) => {
    const stored = built(overrides);
    const frozen = targetFromConfig(stored);
    expect(frozen).not.toBeNull();
    const state = wizardStateFromConfig(
      stored,
      "prompt",
      Date.parse("2026-09-05T12:00:00Z"),
    );
    const rebuilt = buildPlanConfig(state, frozen!);
    if (!rebuilt.ok)
      throw new Error(`unexpected refusal: ${rebuilt.messageKey}`);
    return { stored, rebuilt: rebuilt.config, state };
  };

  it("reproduces every schedule shape byte for byte", () => {
    for (const overrides of [
      {},
      { scheduleKind: "interval" as const },
      { scheduleKind: "cron" as const, timezone: "Asia/Shanghai" },
      { scheduleKind: "loop" as const, maxRuns: "5" },
    ]) {
      const { stored, rebuilt } = roundTrip(overrides);
      expect(rebuilt.schedule, JSON.stringify(overrides)).toEqual(
        stored.schedule,
      );
    }
  });

  it("keeps the policies, bounds and title the plan already had", () => {
    const { stored, rebuilt } = roundTrip({
      misfire: "coalesce",
      concurrency: "queue",
      busyTtlMs: "120000",
      maxRuns: "7",
      expiresAt: "2026-12-01T09:30",
    });
    expect(rebuilt.title).toBe(stored.title);
    expect(rebuilt.misfirePolicy).toBe(stored.misfirePolicy);
    expect(rebuilt.concurrencyPolicy).toBe(stored.concurrencyPolicy);
    expect(rebuilt.busyTtlMs).toBe(stored.busyTtlMs);
    expect(rebuilt.maxRuns).toBe(stored.maxRuns);
    expect(rebuilt.expiresAtUnixMs).toBe(stored.expiresAtUnixMs);
  });

  it("re-sends the frozen target rather than re-deriving one", () => {
    const { stored, rebuilt } = roundTrip();
    expect(rebuilt.target).toEqual(stored.target);
  });

  it("carries an agent target's launch spec and cold-start choice", () => {
    const stored = buildPlanConfig(form({ payload: "每晚复盘" }), {
      ...agentTarget,
      coldStart: true,
    });
    expect(stored.ok).toBe(true);
    if (!stored.ok) return;
    const frozen = targetFromConfig(stored.config);
    expect(frozen?.kind).toBe("agent");
    if (frozen?.kind !== "agent") return;
    expect(frozen.coldStart).toBe(true);
    expect(frozen.agentLaunch).toEqual(agentTarget.agentLaunch);
    const rebuilt = buildPlanConfig(
      wizardStateFromConfig(stored.config, "每晚复盘"),
      frozen,
    );
    expect(rebuilt.ok && rebuilt.config.target).toEqual(stored.config.target);
  });

  it("cannot rebuild an agent target whose launch definition is missing", () => {
    const stored = buildPlanConfig(form({ payload: "x" }), agentTarget);
    expect(stored.ok).toBe(true);
    if (!stored.ok) return;
    const broken = {
      ...stored.config,
      target: { ...stored.config.target!, agentLaunch: undefined },
    };
    expect(targetFromConfig(broken)).toBeNull();
  });
});
