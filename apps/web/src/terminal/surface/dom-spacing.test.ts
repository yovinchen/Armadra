import { describe, expect, it } from "vitest";
import type { Terminal } from "@xterm/xterm";

import { resyncDomRendererSpacing } from "./dom-spacing";

/**
 * 只照着 xterm 里真正会被摸到的那几个内部字段搭的结构替身。`measuredW` 是宽度
 * 缓存报出来的数：**0** 代表元素不在渲染树里——正是这个门存在的理由。
 */
function fakeTerm(options: {
  cellWidth?: number;
  defaultSpacing: number;
  measuredW: number;
}) {
  const calls = { charSizeChanged: 0 };
  const renderer = {
    dimensions: { css: { cell: { width: options.cellWidth ?? 8 } } },
    _rowFactory: { defaultSpacing: options.defaultSpacing },
    _widthCache: {
      get: () => options.measuredW,
    },
    handleCharSizeChanged() {
      calls.charSizeChanged += 1;
      renderer._rowFactory.defaultSpacing =
        renderer.dimensions.css.cell.width - renderer._widthCache.get();
    },
  };
  const terminal = {
    _core: { _renderService: { _renderer: { value: renderer } } },
  } as unknown as Terminal;
  return { terminal, renderer, calls };
}

describe("resyncDomRendererSpacing", () => {
  it("把摘掉时烘进去的「一整格」字距重新推对", () => {
    // 量不出来时建的渲染器：cell.width - 0 = 一整格的 letter-spacing。
    const { terminal, renderer, calls } = fakeTerm({
      cellWidth: 8,
      defaultSpacing: 8,
      measuredW: 8.43,
    });
    expect(resyncDomRendererSpacing(terminal)).toBe(true);
    expect(calls.charSizeChanged).toBe(1);
    expect(renderer._rowFactory.defaultSpacing).toBeCloseTo(-0.43, 5);
  });

  it("字距已经对得上的完全不碰", () => {
    const { terminal, calls } = fakeTerm({
      cellWidth: 8,
      defaultSpacing: -0.43,
      measuredW: 8.43,
    });
    expect(resyncDomRendererSpacing(terminal)).toBe(false);
    expect(calls.charSizeChanged).toBe(0);
  });

  it("测量为 0 时放弃，而不是把同一个错数再烘一遍", () => {
    const { terminal, renderer, calls } = fakeTerm({
      cellWidth: 8,
      defaultSpacing: 8,
      measuredW: 0,
    });
    expect(resyncDomRendererSpacing(terminal)).toBe(false);
    expect(calls.charSizeChanged).toBe(0);
    // 字距一个字节都没动过。
    expect(renderer._rowFactory.defaultSpacing).toBe(8);
  });

  it("cell 宽度还不知道时也放弃", () => {
    const { terminal, calls } = fakeTerm({
      cellWidth: 0,
      defaultSpacing: 8,
      measuredW: 8.43,
    });
    expect(resyncDomRendererSpacing(terminal)).toBe(false);
    expect(calls.charSizeChanged).toBe(0);
  });

  it("没有宽度缓存的渲染器（WebGL）第一道门就出去", () => {
    const terminal = {
      _core: {
        _renderService: {
          _renderer: { value: { handleCharSizeChanged() {}, dimensions: {} } },
        },
      },
    } as unknown as Terminal;
    expect(resyncDomRendererSpacing(terminal)).toBe(false);
  });

  it("内部字段不在时 fail-open，不抛", () => {
    expect(resyncDomRendererSpacing({} as unknown as Terminal)).toBe(false);
    expect(
      resyncDomRendererSpacing({
        _core: { _renderService: {} },
      } as unknown as Terminal),
    ).toBe(false);
  });
});
