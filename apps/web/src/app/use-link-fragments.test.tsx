import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { usePreferencesStore } from "./preferences-store";
import { useCanvasStore } from "@/store/canvas-store";
import { useLinkFragments } from "./use-link-fragments";

/**
 * 服务器壳的两种链接：`#invite=` 与 `#pair=`。
 *
 * 此前这段判断写在设置对话框里，而对话框挂在闸门后面（`Overlays.tsx`）——
 * 只有设置已经打开才会挂载，于是两条链接打开后什么都不会发生。钩子挂在闸门
 * 之外，这里验证它自己把设置开到对应的一页。
 */

const original = window.location.hash;

beforeEach(() => {
  useCanvasStore.getState().setPanel("settings", false);
  usePreferencesStore.getState().setLastSettingsSection("general");
});
afterEach(() => {
  window.history.replaceState(null, "", original || window.location.pathname);
});

describe("useLinkFragments", () => {
  it("邀请链接打开到「账号与共享」", () => {
    window.history.replaceState(null, "", "#invite=tok.en");
    renderHook(() => useLinkFragments(true));
    expect(useCanvasStore.getState().panels.settings).toBe(true);
    expect(usePreferencesStore.getState().lastSettingsSection).toBe("accounts");
  });

  it("配对链接打开到「后台服务」", () => {
    window.history.replaceState(null, "", "#pair=abc.def");
    renderHook(() => useLinkFragments(true));
    expect(useCanvasStore.getState().panels.settings).toBe(true);
    expect(usePreferencesStore.getState().lastSettingsSection).toBe("host");
  });

  it("不是服务器壳、或者没有片段，什么都不做", () => {
    window.history.replaceState(null, "", "#pair=abc.def");
    renderHook(() => useLinkFragments(false));
    expect(useCanvasStore.getState().panels.settings).toBe(false);
    window.history.replaceState(null, "", "#other");
    renderHook(() => useLinkFragments(true));
    expect(useCanvasStore.getState().panels.settings).toBe(false);
    expect(usePreferencesStore.getState().lastSettingsSection).toBe("general");
  });
});
