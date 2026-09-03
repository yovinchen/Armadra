import { describe, expect, it } from "vitest";

import {
  DELTA_LINE,
  DELTA_PAGE,
  DELTA_PIXEL,
  LINES_PER_NOTCH,
  WheelAccumulator,
  wheelToLines,
} from "./scrollback";

describe("滚轮折算（§18.5）", () => {
  it("一个鼠标档位是三行", () => {
    expect(wheelToLines({ deltaY: 120, deltaMode: DELTA_PIXEL }, 24)).toBe(
      LINES_PER_NOTCH,
    );
    expect(wheelToLines({ deltaY: -120, deltaMode: DELTA_PIXEL }, 24)).toBe(
      -LINES_PER_NOTCH,
    );
  });

  it("行模式直接就是行，页模式是一屏", () => {
    expect(wheelToLines({ deltaY: 2, deltaMode: DELTA_LINE }, 24)).toBe(2);
    expect(wheelToLines({ deltaY: 1, deltaMode: DELTA_PAGE }, 24)).toBe(24);
    // rows 为 0（还没量出尺寸）时不能把整页算成 0 行
    expect(wheelToLines({ deltaY: 1, deltaMode: DELTA_PAGE }, 0)).toBe(1);
  });

  it("零与非法值不动", () => {
    expect(wheelToLines({ deltaY: 0, deltaMode: DELTA_PIXEL }, 24)).toBe(0);
    expect(
      wheelToLines({ deltaY: Number.NaN, deltaMode: DELTA_PIXEL }, 24),
    ).toBe(0);
  });
});

describe("滚轮累加器（§18.5）", () => {
  it("向上滚是正数（= 更早的输出）", () => {
    const acc = new WheelAccumulator();
    expect(acc.push({ deltaY: -120, deltaMode: DELTA_PIXEL }, 24)).toBe(3);
    expect(acc.push({ deltaY: 120, deltaMode: DELTA_PIXEL }, 24)).toBe(-3);
  });

  it("触控板的碎增量攒够一行才发，且不丢行", () => {
    const acc = new WheelAccumulator();
    // 每次 -2px = 0.05 行；前 19 次都不该发请求
    let emitted = 0;
    for (let i = 0; i < 19; i += 1) {
      expect(acc.push({ deltaY: -2, deltaMode: DELTA_PIXEL }, 24)).toBe(0);
    }
    // 第 20 次凑满 1 行
    const line = acc.push({ deltaY: -2, deltaMode: DELTA_PIXEL }, 24);
    expect(line).toBe(1);
    emitted += line;
    // 再来 40 次应当正好再出两行
    for (let i = 0; i < 40; i += 1) {
      emitted += acc.push({ deltaY: -2, deltaMode: DELTA_PIXEL }, 24);
    }
    expect(emitted).toBe(3);
  });

  it("换方向时丢掉反向零头，不欠行", () => {
    const acc = new WheelAccumulator();
    // 攒 0.5 行向上
    acc.push({ deltaY: -20, deltaMode: DELTA_PIXEL }, 24);
    // 立刻反向一整档：应当是干净的 -3，而不是被零头吃掉一行
    expect(acc.push({ deltaY: 120, deltaMode: DELTA_PIXEL }, 24)).toBe(-3);
  });

  it("reset 清掉零头", () => {
    const acc = new WheelAccumulator();
    acc.push({ deltaY: -20, deltaMode: DELTA_PIXEL }, 24);
    acc.reset();
    for (let i = 0; i < 19; i += 1) {
      expect(acc.push({ deltaY: -2, deltaMode: DELTA_PIXEL }, 24)).toBe(0);
    }
  });
});
