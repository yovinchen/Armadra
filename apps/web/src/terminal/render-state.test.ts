import { describe, expect, it } from "vitest";

import {
  bufferOffscreenChunk,
  createOffscreenBuffer,
  drainOffscreenBuffer,
  rendersActively,
  resolveRenderState,
  type RenderInputs,
} from "./render-state";

/** 一个「看得见、有名额、没焦点、连接正常」的基线，逐项改写来覆盖各分支。 */
function inputs(patch: Partial<RenderInputs> = {}): RenderInputs {
  return {
    connection: "live",
    collapsed: false,
    onScreen: true,
    pageVisible: true,
    focused: false,
    detached: false,
    budgeted: true,
    ...patch,
  };
}

describe("resolveRenderState", () => {
  it("有焦点且看得见时是 focused", () => {
    expect(resolveRenderState(inputs({ focused: true }))).toBe("focused");
  });

  it("焦点在折叠的节点上不算 focused", () => {
    expect(resolveRenderState(inputs({ focused: true, collapsed: true }))).toBe(
      "offscreen",
    );
  });

  it("窗口切到后台时即使有焦点也不算 focused", () => {
    expect(
      resolveRenderState(inputs({ focused: true, pageVisible: false })),
    ).toBe("offscreen");
  });

  it("看得见且持有名额是 visible", () => {
    expect(resolveRenderState(inputs())).toBe("visible");
  });

  it("看得见但没抢到名额按 offscreen 处理", () => {
    expect(resolveRenderState(inputs({ budgeted: false }))).toBe("offscreen");
  });

  it("滚出视口是 offscreen", () => {
    expect(resolveRenderState(inputs({ onScreen: false }))).toBe("offscreen");
  });

  it("我们自己关掉 socket 是 detached，且压过其它一切", () => {
    expect(resolveRenderState(inputs({ detached: true }))).toBe("detached");
    expect(
      resolveRenderState(
        inputs({ detached: true, focused: true, connection: "detached" }),
      ),
    ).toBe("detached");
  });

  it("socket 意外没了是 disconnected，和 detached 分得开", () => {
    expect(resolveRenderState(inputs({ connection: "detached" }))).toBe(
      "disconnected",
    );
    expect(resolveRenderState(inputs({ connection: "failed" }))).toBe(
      "disconnected",
    );
    // 同一个连接状态，只因为是不是我们主动关的就得出两种结论。
    expect(
      resolveRenderState(inputs({ connection: "detached", detached: true })),
    ).toBe("detached");
  });

  it("进程正常退出不是掉线", () => {
    expect(resolveRenderState(inputs({ connection: "exited" }))).toBe(
      "visible",
    );
    expect(
      resolveRenderState(inputs({ connection: "exited", onScreen: false })),
    ).toBe("offscreen");
  });

  it("连接建立中的可见终端照常全速渲染", () => {
    expect(resolveRenderState(inputs({ connection: "connecting" }))).toBe(
      "visible",
    );
    expect(resolveRenderState(inputs({ connection: "idle" }))).toBe("visible");
    expect(resolveRenderState(inputs({ connection: "starting" }))).toBe(
      "visible",
    );
  });

  it("rendersActively 只认 focused / visible", () => {
    expect(rendersActively("focused")).toBe(true);
    expect(rendersActively("visible")).toBe(true);
    expect(rendersActively("offscreen")).toBe(false);
    expect(rendersActively("detached")).toBe(false);
    expect(rendersActively("disconnected")).toBe(false);
  });
});

describe("离屏缓冲", () => {
  it("按到达顺序原样保留，取出时拼成一段", () => {
    const buffer = createOffscreenBuffer();
    bufferOffscreenChunk(buffer, "a");
    bufferOffscreenChunk(buffer, "b");
    bufferOffscreenChunk(buffer, "c");
    expect(drainOffscreenBuffer(buffer)).toBe("abc");
    expect(buffer.size).toBe(0);
    expect(drainOffscreenBuffer(buffer)).toBe("");
  });

  it("空分片不占位", () => {
    const buffer = createOffscreenBuffer();
    bufferOffscreenChunk(buffer, "");
    expect(buffer.chunks).toHaveLength(0);
  });

  it("越界从头部丢并记账，最新的一段永远留着", () => {
    const buffer = createOffscreenBuffer();
    bufferOffscreenChunk(buffer, "1234", 6);
    bufferOffscreenChunk(buffer, "5678", 6);
    expect(drainOffscreenBuffer(buffer)).toBe("5678");
    expect(buffer.dropped).toBe(4);
  });

  it("单独一段超过上限也不丢它自己", () => {
    const buffer = createOffscreenBuffer();
    bufferOffscreenChunk(buffer, "0123456789", 4);
    expect(drainOffscreenBuffer(buffer)).toBe("0123456789");
    expect(buffer.dropped).toBe(0);
  });

  it("dropped 是累计值，取空之后不清零", () => {
    const buffer = createOffscreenBuffer();
    bufferOffscreenChunk(buffer, "aaaa", 2);
    bufferOffscreenChunk(buffer, "bb", 2);
    drainOffscreenBuffer(buffer);
    expect(buffer.dropped).toBe(4);
  });
});
