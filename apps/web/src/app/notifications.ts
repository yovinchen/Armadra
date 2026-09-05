/**
 * 状态变化的「离屏提醒」（§5.4 最后一段）。
 *
 * 屏幕上已经有胶囊、光晕、MiniMap 描边和侧栏徽标；这里只补最后一环：
 * **用户没在看的时候**，用系统通知与提示音把节点叫回来。因此：
 *
 *  - 只在 `document.hidden || !document.hasFocus()` 时发；窗口在前台时
 *    画布本身就是提示，再弹一条只是噪音。
 *  - 每个节点 5s 节流：claude 的 hook 并行执行，`blocked → working → blocked`
 *    这种抖动一秒能来三次。
 *  - `restored`（Runtime 重启后读回来的旧行）与 20 分钟合成结束边不发：
 *    它们不是「刚跑完」，见 `isFreshDone`。
 *
 * 这个模块还顺带挂了两件同源的副作用（都要一个 App 级的挂载点，且都是
 * 「未读」的生命周期）：选中节点即已读，以及过期权限请求的清扫。
 */
import { useEffect } from "react";
import type { AgentStatus } from "@armadra/shared";

import { onWorkspaceEvent } from "../api/events";
import {
  APPROVAL_TTL_MS,
  isFreshDone,
  useAgentStatusStore,
} from "../agent/status-store";
import { requestCenterOnNode } from "../canvas/editor-context";
import { notify } from "../platform";
import { useCanvasStore } from "../store/canvas-store";
import { t, usePreferencesStore } from "./preferences-store";

/** 每个节点两条提醒之间的最小间隔。通知与提示音各算各的。 */
export const NOTIFY_THROTTLE_MS = 5_000;

/** 过期权限的扫描周期。 */
const SWEEP_INTERVAL_MS = 30_000;

export type NotificationKind = "attention" | "done";

/* ------------------------------- 纯判定 ---------------------------------- */

/**
 * 这条状态帧值不值得提醒。只看「状态变了没有」，不看窗口焦点——
 * 焦点是 `createAgentNotifier` 的门，分开写是为了能单独测。
 *
 * - `blocked` / `waiting`：进入时提醒（`blocked → waiting` 也算一次，
 *   两者的诉求不同：一个等授权，一个等回答）。
 * - `done`：只有新鲜的回合才提醒。
 */
export function notificationFor(
  previous: AgentStatus | undefined,
  next: AgentStatus,
): NotificationKind | null {
  if (next.state === "blocked" || next.state === "waiting") {
    return previous?.state === next.state ? null : "attention";
  }
  if (next.state === "done" && previous?.state !== "done") {
    return isFreshDone(next) ? "done" : null;
  }
  return null;
}

/** 通知正文。节点标题原样带出，其余走消息表。 */
export function notificationText(
  kind: NotificationKind,
  title: string,
): { title: string; body: string } {
  return {
    title: t(`notify.${kind}.title`, { title }),
    body: t(`notify.${kind}.body`),
  };
}

/* ------------------------------- 提示音 ---------------------------------- */

let audioContext: AudioContext | null = null;

function ensureAudioContext(): AudioContext | null {
  if (audioContext) return audioContext;
  const Ctor =
    typeof window === "undefined"
      ? undefined
      : (window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext })
          .webkitAudioContext);
  if (!Ctor) return null;
  try {
    audioContext = new Ctor();
  } catch {
    return null;
  }
  return audioContext;
}

/** 满音量时的峰值增益；设置页的音量条按 0–100 线性缩放它。 */
const PEAK_GAIN = 0.12;

function tone(
  context: AudioContext,
  frequency: number,
  startAt: number,
  durationSeconds: number,
  volume: number,
): void {
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  oscillator.type = "sine";
  oscillator.frequency.value = frequency;
  // 直接切断会「啪」一声，所以两端各做一次极短的斜坡。
  // `exponentialRampToValueAtTime` 不接受 0，所以峰值有一个下限。
  const peak = Math.max(0.0002, PEAK_GAIN * volume);
  gain.gain.setValueAtTime(0.0001, startAt);
  gain.gain.exponentialRampToValueAtTime(peak, startAt + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, startAt + durationSeconds);
  oscillator.connect(gain);
  gain.connect(context.destination);
  oscillator.start(startAt);
  oscillator.stop(startAt + durationSeconds + 0.02);
}

/**
 * 提示音：完成是上行两声（G5 → C6），需要你是一声（A4）。
 * 刻意不做成动画的一部分——`prefers-reduced-motion` 管的是动效，
 * 声音由设置页的开关单独控制。
 */
export function playStatusSound(kind: NotificationKind): void {
  const context = ensureAudioContext();
  if (!context) return;
  // 音量是 0–100 的偏好；0 就干脆不出声，省掉一次 WebAudio 调度。
  const volume = usePreferencesStore.getState().soundVolume / 100;
  if (volume <= 0) return;
  try {
    if (context.state === "suspended") void context.resume();
    const now = context.currentTime;
    if (kind === "done") {
      tone(context, 784, now, 0.09, volume);
      tone(context, 1046, now + 0.11, 0.11, volume);
    } else {
      tone(context, 440, now, 0.18, volume);
    }
  } catch {
    // 用户还没和页面交互过时 WebAudio 会拒绝出声；没什么可补救的。
  }
}

/* ------------------------------- 通知器 ---------------------------------- */

export interface NotifierDeps {
  /** 发一条系统通知。 */
  notify: (title: string, body: string, nodeId: string) => void;
  playSound: (kind: NotificationKind) => void;
  /** 窗口不在前台（隐藏或失焦）。 */
  isBackground: () => boolean;
  /** 节点标题；拿不到时退回 Agent 名。 */
  titleOf: (nodeId: string) => string;
  /**
   * 两个通知开关是分开的（§24.1 通知页）：「后台完成」与「需要你时」各管
   * 各的 `NotificationKind`，提示音仍然只有一个总开关。
   */
  settings: () => {
    notifyDone: boolean;
    notifyNeedsYou: boolean;
    sound: boolean;
  };
  now: () => number;
}

export interface AgentNotifier {
  handle: (status: AgentStatus) => void;
  reset: () => void;
}

/**
 * 事件 → 提醒。状态的「上一帧」记在这里而不是读 store：store 在
 * `agent.status` 到达时已经被 `dispatchWorkspaceEvent` 更新过了，
 * 订阅者拿不到旧值。
 */
export function createAgentNotifier(deps: NotifierDeps): AgentNotifier {
  const previous = new Map<string, AgentStatus>();
  const lastNotifyAt = new Map<string, number>();
  const lastSoundAt = new Map<string, number>();

  const throttled = (
    marks: Map<string, number>,
    nodeId: string,
    now: number,
  ): boolean => {
    const last = marks.get(nodeId);
    if (last !== undefined && now - last < NOTIFY_THROTTLE_MS) return true;
    marks.set(nodeId, now);
    return false;
  };

  return {
    handle(status) {
      const kind = notificationFor(previous.get(status.nodeId), status);
      previous.set(status.nodeId, status);
      if (!kind) return;
      if (!deps.isBackground()) return;

      const now = deps.now();
      const settings = deps.settings();
      const wanted =
        kind === "done" ? settings.notifyDone : settings.notifyNeedsYou;
      if (wanted && !throttled(lastNotifyAt, status.nodeId, now)) {
        const text = notificationText(kind, deps.titleOf(status.nodeId));
        deps.notify(text.title, text.body, status.nodeId);
      }
      if (settings.sound && !throttled(lastSoundAt, status.nodeId, now)) {
        deps.playSound(kind);
      }
    },
    reset() {
      previous.clear();
      lastNotifyAt.clear();
      lastSoundAt.clear();
    },
  };
}

/* --------------------------------- 接线 ---------------------------------- */

function nodeTitle(nodeId: string): string {
  const node = useCanvasStore
    .getState()
    .document?.nodes.find((item) => item.id === nodeId);
  return node?.title || "Agent";
}

/** 点通知：把窗口拉到前面，选中并居中那个节点。 */
function revealNode(nodeId: string): void {
  useCanvasStore.getState().selectNodes([nodeId]);
  requestCenterOnNode(nodeId);
}

export function defaultNotifierDeps(): NotifierDeps {
  return {
    notify: (title, body, nodeId) => {
      void notify(title, body, { onClick: () => revealNode(nodeId) });
    },
    playSound: playStatusSound,
    isBackground: () =>
      typeof document === "undefined"
        ? false
        : document.hidden || !document.hasFocus(),
    titleOf: nodeTitle,
    settings: () => {
      const state = usePreferencesStore.getState();
      return {
        notifyDone: state.notifyDone,
        notifyNeedsYou: state.notifyNeedsYou,
        sound: state.sound,
      };
    },
    now: () => Date.now(),
  };
}

/**
 * App 挂一次。三件事：状态帧 → 通知/提示音；选中节点 → 已读回执；
 * 过期的权限请求 → 清掉头部按钮（`APPROVAL_TTL_MS`）。
 */
export function useAgentNotifications(): void {
  useEffect(() => {
    const notifier = createAgentNotifier(defaultNotifierDeps());
    const off = onWorkspaceEvent("agent.status", (event) => {
      notifier.handle(event.status);
    });

    // 选中即已读：点节点、从侧栏跳过去、MiniMap 点过去都会经过这里。
    const unsubscribe = useCanvasStore.subscribe((state, previous) => {
      const selection = state.selectedNodeIds;
      if (selection === previous.selectedNodeIds) return;
      const statuses = useAgentStatusStore.getState().statuses;
      for (const nodeId of selection) {
        if (previous.selectedNodeIds.includes(nodeId)) continue;
        if (statuses[nodeId]?.unread) {
          useAgentStatusStore.getState().markRead(nodeId);
        }
      }
    });

    const sweep = setInterval(
      () => useAgentStatusStore.getState().sweepApprovals(),
      Math.min(SWEEP_INTERVAL_MS, APPROVAL_TTL_MS),
    );

    return () => {
      off();
      unsubscribe();
      clearInterval(sweep);
      notifier.reset();
    };
  }, []);
}
