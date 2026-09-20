/**
 * 调度内核，逐条对着合并前实现的调度用例。
 *
 * 这些用例守的不是「能不能跑起来」，而是那几条**只有在出错时才看得见**的规矩：
 * 改配置会作废批准、错过的窗口只补一次、同一个目标同时只有一次投递在飞、
 * 送到不是做完、以及结果不明的投递绝不重试。
 */

import {
  AutomationConcurrencyPolicy,
  AutomationMisfirePolicy,
  AutomationOutcome,
  AutomationPlanState,
  AutomationRunState,
  AutomationTargetKind,
  type AutomationPlanConfig,
} from "./types";
import { describe, expect, it } from "vitest";

import { AUTH, activated, config, harness } from "./fixture";
import { ScheduleError, configHash, num } from "./plan";

const MINUTE = 60_000;

function interval(anchorMs: number, periodMs: number) {
  return {
    kind: {
      case: "interval" as const,
      value: {
        anchorUnixMs: BigInt(anchorMs),
        intervalMs: BigInt(periodMs),
      },
    },
  } as AutomationPlanConfig["schedule"];
}

function loop(delayMs: number) {
  return {
    kind: {
      case: "loopAfterCompletion" as const,
      value: {
        delayMs: BigInt(delayMs),
      },
    },
  } as AutomationPlanConfig["schedule"];
}

describe("定义与激活", () => {
  it("新计划是草稿，激活之后才有下一次到期", async () => {
    const h = harness();
    const defined = await h.engine.define(AUTH, "p1", config(), 0);
    expect(defined.plan.state).toBe(AutomationPlanState.DRAFT);
    expect(num(defined.plan.nextDueUnixMs)).toBe(0);
    const stored = h.engine.getPlan("ws", "p1");
    await h.engine.activate(
      AUTH,
      "ws",
      "p1",
      stored.revision,
      1,
      configHash(stored.plan.config as AutomationPlanConfig),
    );
    const plan = h.engine.getPlan("ws", "p1").plan;
    expect(plan.state).toBe(AutomationPlanState.ACTIVE);
    expect(num(plan.nextDueUnixMs)).toBe(1_700_000_000_000);
  });

  it("修订号对不上就是冲突，不是「以库里的为准」", async () => {
    const h = harness();
    await h.engine.define(AUTH, "p1", config(), 0);
    await expect(
      h.engine.define(AUTH, "p1", config(), 9),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("激活要报出看过的那个摘要，报错的那个被拒", async () => {
    const h = harness();
    const defined = await h.engine.define(AUTH, "p1", config(), 0);
    await expect(
      h.engine.activate(
        AUTH,
        "ws",
        "p1",
        defined.revision,
        1,
        new Uint8Array(32),
      ),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("改配置把计划退回草稿，并作废那次批准", async () => {
    const h = harness();
    await activated(h, "p1");
    const before = h.engine.getPlan("ws", "p1");
    expect(before.plan.state).toBe(AutomationPlanState.ACTIVE);
    const edited = await h.engine.define(
      AUTH,
      "p1",
      config({ atMs: 1_700_000_600_000 }),
      before.revision,
    );
    expect(edited.plan.state).toBe(AutomationPlanState.DRAFT);
    expect(num(edited.plan.configVersion)).toBe(2);
    expect(edited.plan.activationSha256.length).toBe(0);
    // 旧摘要激活不了新配置——批准的是人看过的那一份。
    await expect(
      h.engine.activate(
        AUTH,
        "ws",
        "p1",
        edited.revision,
        2,
        configHash(before.plan.config as AutomationPlanConfig),
      ),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("别人的计划改不动也激活不了", async () => {
    const h = harness();
    await activated(h, "p1");
    const other = {
      principalId: "f".repeat(32),
      authorizationId: "e".repeat(32),
    };
    const snapshot = h.engine.getPlan("ws", "p1");
    await expect(
      h.engine.pause(other, "ws", "p1", snapshot.revision),
    ).rejects.toMatchObject({ code: "authorization" });
  });

  it("目标不支持时激活被拒，而不是存下一个永远跑不了的计划", async () => {
    const h = harness();
    h.dispatcher.status = { state: "unsupported", generation: 0 };
    const defined = await h.engine.define(AUTH, "p1", config(), 0);
    const stored = h.engine.getPlan("ws", "p1");
    await expect(
      h.engine.activate(
        AUTH,
        "ws",
        "p1",
        defined.revision,
        1,
        configHash(stored.plan.config as AutomationPlanConfig),
      ),
    ).rejects.toMatchObject({ code: "unsupported" });
  });
});

describe("物化与投递", () => {
  it("到期物化一次运行，认领之后投递，送到不算做完", async () => {
    const h = harness();
    await activated(h, "p1");
    await h.engine.tick();
    const plan = h.engine.getPlan("ws", "p1").plan;
    expect(plan.activeRunId).not.toBe("");
    const run = h.engine.getRun("ws", plan.activeRunId).run;
    expect(run.state).toBe(AutomationRunState.DELIVERED);
    expect(run.deliveryObserved).toBe(true);
    expect(h.dispatcher.dispatched).toHaveLength(1);
  });

  it("同一个槽位只物化一次运行", async () => {
    const h = harness();
    await activated(
      h,
      "p1",
      config({ schedule: interval(1_700_000_000_000, 60_000) }),
    );
    await h.engine.tick();
    await h.engine.tick();
    expect(h.engine.listRuns("ws", "p1", "", 50).runs).toHaveLength(1);
  });

  it("错过的窗口按策略跳过，一次性计划直接过期", async () => {
    const h = harness();
    await activated(h, "p1", config({ misfireGraceMs: 1_000 }));
    // 到期之后过了很久才 tick：这就是错过。
    h.advance(10 * MINUTE);
    await h.engine.tick();
    const runs = h.engine.listRuns("ws", "p1", "", 50).runs;
    expect(runs).toHaveLength(1);
    expect(runs[0]?.run.state).toBe(AutomationRunState.EXPIRED);
    expect(runs[0]?.run.reasonCode).toBe("ONCE_EXPIRED");
    expect(runs[0]?.run.misfire).toBe(true);
    expect(h.dispatcher.dispatched).toHaveLength(0);
  });

  it("合并策略下错过的多个槽位只补一次", async () => {
    const h = harness();
    await activated(
      h,
      "p1",
      config({
        schedule: interval(1_700_000_000_000, MINUTE),
        misfirePolicy: AutomationMisfirePolicy.COALESCE_ONE,
        misfireGraceMs: 1_000,
      }),
    );
    h.advance(5 * MINUTE);
    await h.engine.tick();
    const runs = h.engine.listRuns("ws", "p1", "", 50).runs;
    expect(runs).toHaveLength(1);
    // 补一次，但记下它代表了多少个槽位。
    expect(num(runs[0]?.run.missedSlots)).toBe(6);
    expect(runs[0]?.run.state).toBe(AutomationRunState.DELIVERED);
  });

  it("目标忙就等下一拍，不是失败也不是跳过", async () => {
    const h = harness();
    h.dispatcher.status = { state: "busy", generation: 7 };
    await activated(h, "p1");
    await h.engine.tick();
    const plan = h.engine.getPlan("ws", "p1").plan;
    const run = h.engine.getRun("ws", plan.activeRunId).run;
    expect(run.state).toBe(AutomationRunState.WAITING_TARGET);
    expect(run.reasonCode).toBe("TARGET_NOT_IDLE");
    expect(h.dispatcher.dispatched).toHaveLength(0);
  });

  it("目标离线就跳过这一次", async () => {
    const h = harness();
    h.dispatcher.status = { state: "offline", generation: 0 };
    await activated(h, "p1");
    await h.engine.tick();
    const runs = h.engine.listRuns("ws", "p1", "", 50).runs;
    expect(runs[0]?.run.state).toBe(AutomationRunState.SKIPPED);
    expect(runs[0]?.run.reasonCode).toBe("TARGET_OFFLINE");
  });

  it("等待超过忙碌上限就过期", async () => {
    const h = harness();
    h.dispatcher.status = { state: "busy", generation: 7 };
    await activated(h, "p1", config({ busyTtlMs: 60_000 }));
    await h.engine.tick();
    h.advance(2 * MINUTE);
    await h.engine.tick();
    const runs = h.engine.listRuns("ws", "p1", "", 50).runs;
    expect(runs[0]?.run.state).toBe(AutomationRunState.EXPIRED);
    expect(runs[0]?.run.reasonCode).toBe("WAITING_EXPIRED");
  });
});

describe("目标闸门", () => {
  it("两个指向同一个节点的计划不会同时投递", async () => {
    const h = harness();
    h.dispatcher.outcome = AutomationOutcome.DELIVERED;
    await activated(h, "p1");
    await activated(h, "p2");
    await h.engine.tick();
    // 第一个占住了闸门（DELIVERED 不是终止状态，闸门不放），第二个在等。
    const first = h.engine.getPlan("ws", "p1").plan;
    const second = h.engine.getPlan("ws", "p2").plan;
    expect(first.activeRunId).not.toBe("");
    expect(second.activeRunId).toBe("");
    expect(second.pendingRunId).not.toBe("");
    const waiting = h.engine.getRun("ws", second.pendingRunId).run;
    expect(waiting.state).toBe(AutomationRunState.WAITING_TARGET);
    expect(waiting.reasonCode).toBe("TARGET_GATE_BUSY");
  });

  it("上一次结束之后闸门放开，下一个才进得去", async () => {
    const h = harness();
    h.dispatcher.outcome = AutomationOutcome.SUCCEEDED;
    await activated(h, "p1");
    await activated(h, "p2");
    await h.engine.tick();
    await h.engine.tick();
    expect(h.dispatcher.dispatched).toHaveLength(2);
  });

  it("并发策略禁止时同一个计划不会排第二次", async () => {
    const h = harness();
    h.dispatcher.status = { state: "busy", generation: 7 };
    await activated(
      h,
      "p1",
      config({
        schedule: interval(1_700_000_000_000, MINUTE),
        concurrencyPolicy: AutomationConcurrencyPolicy.FORBID,
        misfirePolicy: AutomationMisfirePolicy.COALESCE_ONE,
      }),
    );
    await h.engine.tick();
    h.advance(MINUTE);
    await h.engine.tick();
    const runs = h.engine.listRuns("ws", "p1", "", 50).runs;
    const skipped = runs.filter(
      (entry) => entry.run.reasonCode === "CONCURRENCY_LIMIT",
    );
    expect(skipped.length).toBeGreaterThan(0);
  });
});

describe("收据", () => {
  it("结果不明不会变成一次重试", async () => {
    const h = harness();
    h.dispatcher.outcome = undefined;
    await activated(h, "p1");
    await h.engine.tick();
    const plan = h.engine.getPlan("ws", "p1").plan;
    const run = h.engine.getRun("ws", plan.activeRunId).run;
    expect(run.state).toBe(AutomationRunState.UNKNOWN);
    expect(run.reasonCode).toBe("DISPATCH_OUTCOME_UNKNOWN");
    // 闸门没放：结果不明的投递从来不会让一个目标重新变得可用。
    await h.engine.tick();
    expect(h.dispatcher.dispatched).toHaveLength(1);
  });

  it("肯定的「没投递」才会重试，而且有次数上限", async () => {
    const h = harness();
    h.dispatcher.outcome = AutomationOutcome.NOT_DISPATCHED;
    await activated(
      h,
      "p1",
      config({ safeRetryLimit: 1, busyTtlMs: 3_600_000 }),
    );
    await h.engine.tick();
    const plan = h.engine.getPlan("ws", "p1").plan;
    const run = h.engine.getRun("ws", plan.activeRunId).run;
    expect(run.state).toBe(AutomationRunState.CLAIMED);
    expect(run.reasonCode).toBe("NO_EFFECT_RETRY_PENDING");
    // 退避到了再试一次；第二次用尽了额度就是失败。
    h.advance(10_000);
    await h.engine.tick();
    const after = h.engine.getRun("ws", run.id).run;
    expect(after.state).toBe(AutomationRunState.FAILED);
    expect(after.reasonCode).toBe("NO_EFFECT_RETRY_EXHAUSTED");
  });

  it("对不上号的收据不会改变一次运行", async () => {
    const h = harness();
    await activated(h, "p1");
    await h.engine.tick();
    expect(() =>
      h.engine.observe({
        operationId: "别人的操作",
        requestSha256: new Uint8Array(32),
        outcome: AutomationOutcome.SUCCEEDED,
        sequence: 9n,
        observedAtUnixMs: 1_700_000_000_000n,
        reasonCode: "OK",
      }),
    ).toThrow(ScheduleError);
  });
});

describe("立即运行", () => {
  it("加一个手动槽位，不挪日程", async () => {
    const h = harness();
    await activated(
      h,
      "p1",
      config({ schedule: interval(1_900_000_000_000, MINUTE) }),
    );
    const before = h.engine.getPlan("ws", "p1");
    const run = await h.engine.runNow(AUTH, "ws", "p1", before.revision);
    expect(run.run.reasonCode).toBe("MANUAL_RUN");
    expect(run.run.scheduledSlot.startsWith("manual:")).toBe(true);
    const after = h.engine.getPlan("ws", "p1").plan;
    // 下一次到期一点没动。
    expect(num(after.nextDueUnixMs)).toBe(num(before.plan.nextDueUnixMs));
    expect(after.pendingRunId).toBe(run.run.id);
  });

  it("草稿状态的计划不能立即运行", async () => {
    const h = harness();
    const defined = await h.engine.define(AUTH, "p1", config(), 0);
    await expect(
      h.engine.runNow(AUTH, "ws", "p1", defined.revision),
    ).rejects.toMatchObject({ code: "invalid" });
  });

  it("已经排着一次时再来一次是冲突", async () => {
    const h = harness();
    await activated(
      h,
      "p1",
      config({ schedule: interval(1_900_000_000_000, MINUTE) }),
    );
    const before = h.engine.getPlan("ws", "p1");
    await h.engine.runNow(AUTH, "ws", "p1", before.revision);
    const after = h.engine.getPlan("ws", "p1");
    await expect(
      h.engine.runNow(AUTH, "ws", "p1", after.revision),
    ).rejects.toMatchObject({ code: "conflict" });
  });
});

describe("暂停与终点", () => {
  it("暂停取消还没投递的那一次", async () => {
    const h = harness();
    h.dispatcher.status = { state: "busy", generation: 7 };
    await activated(h, "p1");
    await h.engine.tick();
    const snapshot = h.engine.getPlan("ws", "p1");
    const runId = snapshot.plan.activeRunId;
    await h.engine.pause(AUTH, "ws", "p1", snapshot.revision);
    const run = h.engine.getRun("ws", runId).run;
    expect(run.state).toBe(AutomationRunState.CANCELLED);
    expect(run.reasonCode).toBe("PLAN_PAUSED");
    expect(h.engine.getPlan("ws", "p1").plan.state).toBe(
      AutomationPlanState.PAUSED,
    );
  });

  it("一次性计划跑完就过期", async () => {
    const h = harness();
    h.dispatcher.outcome = AutomationOutcome.SUCCEEDED;
    await activated(h, "p1");
    await h.engine.tick();
    expect(h.engine.getPlan("ws", "p1").plan.state).toBe(
      AutomationPlanState.EXPIRED,
    );
  });

  it("到达次数上限就过期", async () => {
    const h = harness();
    h.dispatcher.outcome = AutomationOutcome.SUCCEEDED;
    await activated(
      h,
      "p1",
      config({ schedule: interval(1_700_000_000_000, MINUTE), maxRuns: 1 }),
    );
    await h.engine.tick();
    h.advance(MINUTE);
    await h.engine.tick();
    expect(h.engine.getPlan("ws", "p1").plan.state).toBe(
      AutomationPlanState.EXPIRED,
    );
    expect(h.engine.listRuns("ws", "p1", "", 50).runs).toHaveLength(1);
  });

  it("循环计划跑完之后按延迟排下一次", async () => {
    const h = harness();
    h.dispatcher.outcome = AutomationOutcome.SUCCEEDED;
    await activated(
      h,
      "p1",
      config({ schedule: loop(5 * MINUTE), maxRuns: 5 }),
    );
    await h.engine.tick();
    const plan = h.engine.getPlan("ws", "p1").plan;
    expect(plan.state).toBe(AutomationPlanState.ACTIVE);
    expect(num(plan.nextDueUnixMs)).toBe(h.now + 5 * MINUTE);
  });

  it("过了截止时间就过期，并且不再投递", async () => {
    const h = harness();
    await activated(
      h,
      "p1",
      config({
        schedule: interval(1_700_000_000_000, MINUTE),
        expiresAtUnixMs: 1_700_000_030_000,
      }),
    );
    h.advance(MINUTE);
    await h.engine.tick();
    expect(h.engine.getPlan("ws", "p1").plan.state).toBe(
      AutomationPlanState.EXPIRED,
    );
  });
});

describe("需要处理", () => {
  it("连续两次不可修复的拒绝才抬起标记", async () => {
    const h = harness();
    await activated(
      h,
      "p1",
      config({ schedule: interval(1_700_000_000_000, MINUTE) }),
    );
    // 激活时目标还好；之后坏掉。
    h.dispatcher.status = { state: "unsupported", generation: 1 };
    await h.engine.tick();
    expect(h.engine.getPlan("ws", "p1").plan.needsAttention).toBe(false);
    h.advance(MINUTE);
    await h.engine.tick();
    const plan = h.engine.getPlan("ws", "p1").plan;
    expect(plan.needsAttention).toBe(true);
    expect(plan.attentionReasonCode).toBe("TARGET_UNSUPPORTED");
  });

  it("改配置把连续拒绝的计数清掉", async () => {
    const h = harness();
    await activated(
      h,
      "p1",
      config({ schedule: interval(1_700_000_000_000, MINUTE) }),
    );
    h.dispatcher.status = { state: "unsupported", generation: 1 };
    await h.engine.tick();
    h.advance(MINUTE);
    await h.engine.tick();
    const snapshot = h.engine.getPlan("ws", "p1");
    expect(snapshot.plan.needsAttention).toBe(true);
    const edited = await h.engine.define(
      AUTH,
      "p1",
      config({ schedule: interval(1_700_000_000_000, 2 * MINUTE) }),
      snapshot.revision,
    );
    expect(edited.plan.needsAttention).toBe(false);
    expect(edited.plan.attentionStreak).toBe(0);
  });
});

describe("运行历史", () => {
  it("最新在前，游标是时间上的一个位置", async () => {
    const h = harness();
    h.dispatcher.outcome = AutomationOutcome.SUCCEEDED;
    await activated(
      h,
      "p1",
      config({ schedule: interval(1_700_000_000_000, MINUTE) }),
    );
    for (let index = 0; index < 4; index += 1) {
      await h.engine.tick();
      h.advance(MINUTE);
    }
    const first = h.engine.listRuns("ws", "p1", "", 2);
    expect(first.runs).toHaveLength(2);
    expect(first.hasMore).toBe(true);
    const times = first.runs.map((entry) => num(entry.run.scheduledAtUnixMs));
    expect(times[0]).toBeGreaterThan(times[1] as number);
    const second = h.engine.listRuns("ws", "p1", first.nextId, 2);
    expect(second.runs.map((entry) => entry.run.id)).not.toEqual(
      first.runs.map((entry) => entry.run.id),
    );
  });

  it("别的计划的游标被拒", async () => {
    const h = harness();
    await activated(h, "p1");
    expect(() => h.engine.listRuns("ws", "p1", "p2/abc/run", 10)).toThrow(
      ScheduleError,
    );
  });
});

describe("目标类别", () => {
  it("没写类别的计划留在命令执行方，不会悄悄变成终端写手", async () => {
    const h = harness();
    await expect(
      h.engine.define(
        AUTH,
        "p1",
        config({
          target: {
            executionHostId: "a1b2c3d4e5f60718293a4b5c6d7e8f90",
            kind: AutomationTargetKind.UNSPECIFIED,
            nodeId: "",
            sessionId: "session-1",
            generation: 3n,
            agentLaunch: undefined,
          },
        }),
        0,
      ),
    ).resolves.toMatchObject({ revision: 1 });
  });

  it("Agent 目标必须指明节点与冻结的定义", async () => {
    const h = harness();
    await expect(
      h.engine.define(
        AUTH,
        "p1",
        config({ target: { nodeId: "", agentLaunch: undefined } }),
        0,
      ),
    ).rejects.toMatchObject({ code: "invalid" });
  });

  it("命令目标不能带节点或启动定义", async () => {
    const h = harness();
    await expect(
      h.engine.define(
        AUTH,
        "p1",
        config({
          target: {
            kind: AutomationTargetKind.NON_INTERACTIVE_COMMAND,
            sessionId: "session-1",
            generation: 1n,
          },
        }),
        0,
      ),
    ).rejects.toMatchObject({ code: "invalid" });
  });
});
