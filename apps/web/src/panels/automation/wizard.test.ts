import { describe, expect, it } from "vitest";

import {
  buildLaunchSpec,
  buildPlanConfig,
  defaultWizardState,
  localInput,
  type WizardState,
} from "./wizard";

const target = {
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
    expect(built({ misfire: "skip" }).misfirePolicy).toBe(1);
    expect(built({ misfire: "coalesce" }).misfirePolicy).toBe(2);
    expect(built({ concurrency: "forbid" }).concurrencyPolicy).toBe(1);
    expect(built({ concurrency: "queue" }).concurrencyPolicy).toBe(2);
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
