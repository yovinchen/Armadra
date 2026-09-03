/**
 * Runtime 所在的操作系统（计划书 §18.3「Windows 直连」）。
 *
 * xterm 的 `windowsPty` 必须在 `open()` 之前设好，而它取决于 **Runtime**
 * 跑在哪儿——不是浏览器跑在哪儿（开发时前端在 macOS、Runtime 在别处的
 * 情况是存在的）。`GET /api/terminals/backend` 上报它。
 *
 * 这里刻意不走 `runtimeApi`：`terminalBackendInfoSchema` 是非 strict 的
 * `z.object`，未知键会被静默丢掉，加字段就得改 `packages/shared`（不归我们）。
 * 一次裸 fetch + 一个进程内缓存足够了。
 */

import { RUNTIME_URL } from "@/api/client";

export type RuntimePlatform = "unix" | "windows";

let cached: RuntimePlatform | null = null;
let inflight: Promise<RuntimePlatform> | null = null;

/** 同步读缓存。第一个终端节点挂载时还是 `null`，此时按 unix 处理。 */
export function runtimePlatform(): RuntimePlatform | null {
  return cached;
}

export async function loadRuntimePlatform(): Promise<RuntimePlatform> {
  if (cached) return cached;
  inflight ??= (async () => {
    try {
      const response = await fetch(`${RUNTIME_URL}/api/terminals/backend`);
      const payload: unknown = await response.json();
      const platform =
        typeof payload === "object" &&
        payload !== null &&
        (payload as { platform?: unknown }).platform === "windows"
          ? "windows"
          : "unix";
      cached = platform;
      return platform;
    } catch {
      // Runtime 还没起来：按 unix 走，下一个节点会再问一次。
      inflight = null;
      return "unix";
    }
  })();
  return inflight;
}

/** 测试用。 */
export function resetRuntimePlatform(): void {
  cached = null;
  inflight = null;
}
