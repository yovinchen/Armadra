import * as React from "react";

import { shouldRefit } from "../compat";
import type { SurfaceRefs } from "./refs";

/**
 * §18.2 规则 2：**唯一**允许调 `fit()` 的地方。
 *
 * 先问 `proposeDimensions()`，只有算出来的整数列/行和当前不一样才动手，
 * 也才发 `resize`。这一条就是「终端一直跳」的解药：`fit()` 会让 tmux
 * 整屏重绘、重绘可能让容器再抖一个亚像素，如果不比较就会无限循环。
 */
export function useRefit(refs: SurfaceRefs): () => void {
  return React.useCallback(() => {
    const terminal = refs.terminalRef.current;
    const fit = refs.fitRef.current;
    if (!terminal || !fit || !refs.visibleRef.current) return;
    let proposed: { cols: number; rows: number } | undefined;
    try {
      proposed = fit.proposeDimensions();
    } catch {
      return;
    }
    if (!shouldRefit(proposed, { cols: terminal.cols, rows: terminal.rows })) {
      return;
    }
    try {
      fit.fit();
    } catch {
      return;
    }
    refs.transportRef.current?.resize(terminal.cols, terminal.rows);
  }, [refs]);
}
