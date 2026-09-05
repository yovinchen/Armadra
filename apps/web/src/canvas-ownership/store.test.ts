import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const canvasOwnership = vi.fn();
vi.mock("../api/client", () => ({
  runtimeApi: { canvasOwnership: () => canvasOwnership() },
}));

const { canEditCanvas, useCanvasOwnership } = await import("./store");

const base = {
  domain: "canvas" as const,
  epoch: 9_007_199_254_740_993n,
  reasonCode: "ownership.switch.verified",
  updatedAt: "2026-09-05T10:00:00.000Z",
};

// 花括号是必须的：箭头直接返回 mock 会被 vitest 当成清理回调，
// 测试结束后再调一次，那次调用的拒绝没人接，会变成未处理拒绝。
beforeEach(() => {
  canvasOwnership.mockReset();
});
afterEach(() => {
  useCanvasOwnership.getState().reset();
});

describe("画布归属探测", () => {
  it("Runtime 在写", async () => {
    canvasOwnership.mockResolvedValue({
      ...base,
      owner: "runtime",
      phase: "settled",
    });
    expect(await useCanvasOwnership.getState().probe()).toBe("runtime");
    const state = useCanvasOwnership.getState();
    expect(state.status).toBe("runtime");
    // u64 的纪元原样留成 bigint：经过 number 会把相邻两代读成同一代。
    expect(state.epoch).toBe(9_007_199_254_740_993n);
    expect(canEditCanvas(state.status)).toBe(true);
  });

  it("Host 在写", async () => {
    canvasOwnership.mockResolvedValue({
      ...base,
      owner: "host",
      phase: "settled",
    });
    expect(await useCanvasOwnership.getState().probe()).toBe("host");
    expect(canEditCanvas(useCanvasOwnership.getState().status)).toBe(true);
  });

  it("切换进行中就是维护：画布只读", async () => {
    canvasOwnership.mockResolvedValue({
      ...base,
      owner: "runtime",
      phase: "switching",
    });
    expect(await useCanvasOwnership.getState().probe()).toBe("maintenance");
    expect(canEditCanvas(useCanvasOwnership.getState().status)).toBe(false);
  });

  it("回滚同样按维护处理", async () => {
    canvasOwnership.mockResolvedValue({
      ...base,
      owner: "host",
      phase: "rollingBack",
    });
    expect(await useCanvasOwnership.getState().probe()).toBe("maintenance");
  });

  /** 探不到不是「大概是 Runtime」；它是一个会禁写的真状态。 */
  it("探测失败落在 error，并且不保留上一次的纪元", async () => {
    canvasOwnership.mockRejectedValue(new Error("boom"));
    expect(await useCanvasOwnership.getState().probe()).toBe("error");
    const state = useCanvasOwnership.getState();
    expect(state.status).toBe("error");
    expect(state.epoch).toBeNull();
    expect(canEditCanvas(state.status)).toBe(false);
  });

  it("端点根本不存在时也落在 error，而不是把异常抛进渲染", async () => {
    canvasOwnership.mockImplementation(() => {
      throw new TypeError("runtimeApi.canvasOwnership is not a function");
    });
    await expect(useCanvasOwnership.getState().probe()).resolves.toBe("error");
  });

  it("并发探测只发一次请求", async () => {
    canvasOwnership.mockResolvedValue({
      ...base,
      owner: "runtime",
      phase: "settled",
    });
    const probe = useCanvasOwnership.getState().probe;
    await Promise.all([probe(), probe(), probe()]);
    expect(canvasOwnership).toHaveBeenCalledTimes(1);
  });

  it("初始状态是 unknown，不是「已就绪」", () => {
    expect(useCanvasOwnership.getState().status).toBe("unknown");
    expect(canEditCanvas("unknown")).toBe(false);
  });
});
