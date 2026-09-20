import { beforeEach, describe, expect, it } from "vitest";
import type { WorkspaceEvent } from "@armadra/shared";

import {
  DELIVERY_FLASH_MS,
  NOTICE_REPEAT_MS,
  edgeKey,
  isFlashing,
  reduce,
  useDeliveryStore,
} from "./delivery-store";

/**
 * 投递在界面上的那一点痕迹（设计 `agent-delivery.md` §10）。
 *
 * 三条规矩值得单独守：连线上的那一下闪动会自己停；被拦下的同一件事只说一次；
 * 人关掉之后在那个窗口里不再回来。
 */

const frame = (
  outcome: string,
  code?: string,
  source = "node-a",
  target = "node-b",
): Extract<WorkspaceEvent, { type: "agent.delivery" }> =>
  ({
    type: "agent.delivery",
    traceId: "t-1",
    sourceNodeId: source,
    targetNodeId: target,
    outcome,
    ...(code === undefined ? {} : { code }),
  }) as Extract<WorkspaceEvent, { type: "agent.delivery" }>;

const empty = {
  marks: {},
  queueVersion: {},
  notices: [],
  dismissedAt: {},
} as const;

beforeEach(() => {
  useDeliveryStore.getState().reset();
});

describe("reduce", () => {
  it("记下这条边最近一次投递，方向是有意义的", () => {
    const next = reduce(empty, frame("delivered"), 1_000);
    expect(next.marks?.[edgeKey("node-a", "node-b")]).toMatchObject({
      outcome: "delivered",
      at: 1_000,
    });
    expect(next.marks?.[edgeKey("node-b", "node-a")]).toBeUndefined();
  });

  it("排队与出队让那个目标的队伍重读；被拦下的那条从来没进过队", () => {
    const queued = reduce(empty, frame("queued"), 1);
    expect(queued.queueVersion).toEqual({ "node-b": 1 });
    const refused = reduce(empty, frame("refused", "LOOP_DETECTED"), 1);
    expect(refused.queueVersion).toBeUndefined();
  });

  it("只有值得占顶部一行的那几个码才变成通知", () => {
    expect(reduce(empty, frame("refused", "BODY_TOO_LONG"), 1).notices).toBe(
      undefined,
    );
    expect(
      reduce(empty, frame("refused", "LOOP_DETECTED"), 1).notices,
    ).toHaveLength(1);
  });

  it("同一条边撞同一个码只留一条，计数加一", () => {
    const first = reduce(empty, frame("refused", "RATE_LIMITED"), 1);
    const state = { ...empty, ...first } as typeof empty;
    const second = reduce(state, frame("refused", "RATE_LIMITED"), 2);
    expect(second.notices).toHaveLength(1);
    expect(second.notices?.[0]).toMatchObject({ count: 2, at: 2 });
  });

  it("关掉之后在那个窗口里不再回来，过了就能再说一次", () => {
    const store = useDeliveryStore.getState();
    store.handleEvent(frame("refused", "LOOP_DETECTED"), 1_000);
    const id = useDeliveryStore.getState().notices[0]?.id as string;
    useDeliveryStore.getState().dismissNotice(id, 1_000);
    expect(useDeliveryStore.getState().notices).toHaveLength(0);

    useDeliveryStore
      .getState()
      .handleEvent(frame("refused", "LOOP_DETECTED"), 1_000 + 1);
    expect(useDeliveryStore.getState().notices).toHaveLength(0);

    useDeliveryStore
      .getState()
      .handleEvent(frame("refused", "LOOP_DETECTED"), 1_000 + NOTICE_REPEAT_MS);
    expect(useDeliveryStore.getState().notices).toHaveLength(1);
  });
});

describe("isFlashing", () => {
  it("闪一下就停，没有痕迹的边不闪", () => {
    const mark = {
      sourceNodeId: "a",
      targetNodeId: "b",
      outcome: "delivered",
      at: 1_000,
    };
    expect(isFlashing(undefined, 1_000)).toBe(false);
    expect(isFlashing(mark, 1_000)).toBe(true);
    expect(isFlashing(mark, 1_000 + DELIVERY_FLASH_MS)).toBe(false);
  });
});
