import type { BoardPresence } from "@armadra/shared";

import { useCanvasStore } from "../canvas-store";
import { clearLocalEdits } from "./pending";
import type { CanvasGet, CanvasSet, CanvasState, CanvasStore } from "./types";

/**
 * 在线设备与编辑租约（core JSON §9）在页面这一侧的那一半。
 *
 * core 说了算：谁在看、谁持有写租约都来自心跳的回答与 `canvas.presence`
 * 事件，这里只存最近的一份并据此回答「这块画布此刻能不能改」。心跳本身在
 * `app/use-board-sync.ts`。
 *
 * **只读的判定**：租约在**别人**手里。租约空着不算只读——那时谁先动手谁
 * 拿，第一次保存会顺手拿到它；单设备的人因此永远走不到只读这一支。
 */

const CLIENT_KEY = "armadra.canvasClient";

/**
 * 这个页面的 `clientId`。
 *
 * 存在 sessionStorage 里、**读出来就删掉**、页面隐藏时再写回：刷新一次沿用
 * 同一个 id（不然刷新前那个「自己」会以另一台设备的身份把租约占着直到过期），
 * 而「复制标签页」复制到的是一份已经被删掉的存储，拿到的是新的 id——两个
 * 标签页共用一个 id 会让 core 把它们当成同一个写者。
 */
function mintClientId(): string {
  const random =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}`;
  let id = random.replace(/[^A-Za-z0-9_-]/g, "");
  try {
    const stored = window.sessionStorage.getItem(CLIENT_KEY);
    if (stored && /^[A-Za-z0-9_-]{8,128}$/.test(stored)) id = stored;
    window.sessionStorage.removeItem(CLIENT_KEY);
    window.addEventListener("pagehide", () => {
      try {
        window.sessionStorage.setItem(CLIENT_KEY, id);
      } catch {
        // 存不进去（隐私模式）就是下一次换一个 id，不影响本次。
      }
    });
  } catch {
    // 没有 sessionStorage（测试、受限环境）：每次加载一个新 id。
  }
  return id;
}

let clientId: string | null = null;

export function presenceClientId(): string {
  clientId ??= mintClientId();
  return clientId;
}

/**
 * 给别人看的设备名：系统，页面里再加浏览器。只用于显示，core 原样转发。
 */
export function presenceDeviceName(): string {
  if (typeof navigator === "undefined") return "";
  const agent = navigator.userAgent;
  const os = /iPhone/.test(agent)
    ? "iPhone"
    : /iPad/.test(agent) ||
        (/Macintosh/.test(agent) && navigator.maxTouchPoints > 1)
      ? "iPad"
      : /Android/.test(agent)
        ? "Android"
        : /Mac OS X|Macintosh/.test(agent)
          ? "macOS"
          : /Windows/.test(agent)
            ? "Windows"
            : /Linux/.test(agent)
              ? "Linux"
              : "";
  if (typeof window !== "undefined" && window.armadra !== undefined) return os;
  const browser = /Edg\//.test(agent)
    ? "Edge"
    : /Firefox\//.test(agent)
      ? "Firefox"
      : /Chrome\//.test(agent)
        ? "Chrome"
        : /Safari\//.test(agent)
          ? "Safari"
          : "";
  return [os, browser].filter(Boolean).join(" · ");
}

/* --------------------------------- 活动 ---------------------------------- */

let active = false;

/** 指针或键盘碰过画布。下一次心跳带着它，好让 core 判断谁在空闲。 */
export function markPresenceActivity(): void {
  active = true;
}

/** 取走并清零。 */
export function takePresenceActivity(): boolean {
  const was = active;
  active = false;
  return was;
}

/* --------------------------------- 判定 ---------------------------------- */

/** 当前画布的在线表；属于别的画布的旧快照不算。 */
export function currentPresence(
  state: Pick<CanvasState, "boardId" | "presence">,
): BoardPresence | null {
  const presence = state.presence;
  if (!presence || presence.boardId !== state.boardId) return null;
  return presence;
}

/**
 * 编辑动作一律不落：租约在别人手里，或者这个人对这块工作空间没有写权限
 * （服务器壳上的只读共享，心跳回答 `writable: false`）。
 */
export function isReadOnly(
  state: Pick<CanvasState, "boardId" | "presence">,
): boolean {
  const current = currentPresence(state);
  if (current?.writable === false) return true;
  const lease = current?.lease;
  return Boolean(lease && lease.clientId !== presenceClientId());
}

export function useCanvasReadOnly(): boolean {
  return useCanvasStore(isReadOnly);
}

/**
 * 收下一份在线表（心跳的回答或 `canvas.presence` 事件）。
 *
 * 从可写变成只读的那一刻（别的设备接管了），本地还没落盘的改动作废：它们
 * 写出去只会被 423 拒，留着只会让保存指示灯一直亮着「未保存」。返回值告诉
 * 调用方要不要按远端重载这块画布。
 */
export function applyPresence(presence: BoardPresence): {
  lost: boolean;
  gained: boolean;
} {
  const state = useCanvasStore.getState();
  if (presence.boardId !== state.boardId) return { lost: false, gained: false };
  const before = isReadOnly(state);
  // `writable` 只在心跳的回答里；事件帧没有它，沿用这块画布上一拍的判定，
  // 否则别人来了的那一帧会把只读冲掉。
  const writable = presence.writable ?? currentPresence(state)?.writable;
  const snapshot: BoardPresence = {
    boardId: presence.boardId,
    clients: presence.clients,
    lease: presence.lease,
    ...(writable === undefined ? {} : { writable }),
  };
  state.setPresence(snapshot);
  const after = isReadOnly(useCanvasStore.getState());
  if (!before && after) {
    clearLocalEdits();
    useCanvasStore.setState({ saveState: "saved", saveError: null });
  }
  return { lost: !before && after, gained: before && !after };
}

/* --------------------------------- 切片 ---------------------------------- */

export function createPresenceSlice(
  set: CanvasSet,
  _get: CanvasGet,
): Pick<CanvasStore, "presence" | "setPresence"> {
  return {
    presence: null,
    setPresence: (presence) => set({ presence }),
  };
}

/** 仅测试用：换一个 id、清掉活动标记。 */
export function resetPresenceClient(id: string | null = null): void {
  clientId = id;
  active = false;
}
