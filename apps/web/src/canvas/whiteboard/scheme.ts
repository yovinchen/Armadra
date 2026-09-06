import {
  usePreferencesStore,
  useResolvedTheme,
  resolveTheme,
} from "@/app/preferences-store";
import { canvasColorScheme } from "@/app/use-canvas-preferences";

import type { ColorScheme } from "./palette";

/**
 * 白板对象取哪一套色值（React Flow 计划 §2.4，归属 whiteboard）。
 *
 * 判据是**画布底色**而不是应用主题：把画布背景设成「纯黑」的用户，即使
 * 应用主题是浅色，墨迹也该用深色底那一套；`canvasColorScheme` 已经把这条
 * 规则写成纯函数并有单测，这里只是把它接到偏好上。
 */

export function useCanvasScheme(): ColorScheme {
  const background = usePreferencesStore(
    (state) => state.whiteboard.background,
  );
  const theme = useResolvedTheme();
  return canvasColorScheme(background, theme);
}

/** 非 React 的调用方（栅格化、剪贴板）用这个读一次当前值。 */
export function canvasScheme(): ColorScheme {
  const state = usePreferencesStore.getState();
  return canvasColorScheme(state.whiteboard.background, resolveTheme(state));
}
