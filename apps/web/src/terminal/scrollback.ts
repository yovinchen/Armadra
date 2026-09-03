/**
 * 滚轮 → tmux 历史的桥（计划书 §18.5）。
 *
 * tmux 客户端故意不开鼠标模式（否则 xterm 就不做原生选区了），所以滚轮
 * 根本到不了 tmux。这里把浏览器的 wheel 事件折算成整行数，节流之后交给
 * Runtime 的 `POST /api/terminals/{id}/scroll`。
 *
 * 纯逻辑单独放在这里，是因为「多少像素算一行」这种事只能靠单测钉死：
 * 不同设备的 `deltaY` 差一个数量级，触控板还会连着发几十个小增量。
 */

import { RUNTIME_URL } from "@/api/client";

/** 一个滚轮档位（传统 120 单位）滚多少行。 */
export const LINES_PER_NOTCH = 3;
/** 一个档位的像素增量基准。Chrome/WebKit 桌面鼠标就是 120。 */
const PIXELS_PER_NOTCH = 120;
/** 请求节流：30ms 一次，中间的增量攒着。 */
export const SCROLL_THROTTLE_MS = 30;

/** `WheelEvent.deltaMode` 的三个取值。 */
export const DELTA_PIXEL = 0;
export const DELTA_LINE = 1;
export const DELTA_PAGE = 2;

export interface WheelLike {
  deltaY: number;
  deltaMode: number;
}

/**
 * 一次 wheel 事件折算成多少行（**未取整**，符号同 `deltaY`：正 = 向下）。
 *
 * `rows` 只在整页滚动时用得上，给一个屏幕的高度。
 */
export function wheelToLines(event: WheelLike, rows: number): number {
  if (!Number.isFinite(event.deltaY) || event.deltaY === 0) return 0;
  switch (event.deltaMode) {
    case DELTA_LINE:
      return event.deltaY;
    case DELTA_PAGE:
      return event.deltaY * Math.max(1, rows);
    default:
      return (event.deltaY * LINES_PER_NOTCH) / PIXELS_PER_NOTCH;
  }
}

/**
 * 攒零头的累加器。
 *
 * 触控板一次轻扫会发几十个 `deltaY: 2` 的事件；逐个取整会全部变成 0，
 * 滚不动。把小数留在 `remainder` 里，凑够一行才吐出来。
 */
export class WheelAccumulator {
  private remainder = 0;

  /**
   * 吃掉一次 wheel，返回**要向历史方向滚动的整行数**（正 = 往回看更早的
   * 输出，正好是 Runtime `scroll` 接口的方向），没凑够一行就返回 0。
   */
  push(event: WheelLike, rows: number): number {
    const lines = wheelToLines(event, rows);
    if (lines === 0) return 0;
    // 换方向时先把反向的零头丢掉，否则回滚会先"欠"几行。
    if (
      this.remainder !== 0 &&
      Math.sign(this.remainder) !== Math.sign(lines)
    ) {
      this.remainder = 0;
    }
    this.remainder += lines;
    const whole = Math.trunc(this.remainder);
    if (whole === 0) return 0;
    this.remainder -= whole;
    // 浏览器里向上滚是负 deltaY，而接口里"正 = 更早的输出"。
    return -whole;
  }

  reset(): void {
    this.remainder = 0;
  }
}

/* ------------------------------- 请求发送 --------------------------------- */

/**
 * `POST /api/terminals/{id}/scroll`。
 *
 * 和 `platform.ts` 一样走裸 fetch：这是个 204 空响应的动作接口，
 * 塞进 `runtimeApi`（不归我们）只会多一次跨模块改动。
 */
export async function postScroll(
  sessionId: string,
  lines: number,
): Promise<void> {
  if (lines === 0) return;
  try {
    await fetch(`${RUNTIME_URL}/api/terminals/${sessionId}/scroll`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ lines }),
    });
  } catch {
    // 滚不动就滚不动，不打断终端。
  }
}
