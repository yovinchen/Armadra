import { LifecycleState } from "../shell-core/lifecycle-state";
import type { RuntimeProcess } from "./runtime-process";

/**
 * 关掉前台窗口不停任何服务；显式退出才停 core。
 *
 * 三段式的状态本身是纯的，住在 `shell-core/lifecycle-state.ts`。
 */

export class DesktopLifecycle {
  readonly state = new LifecycleState();
}

export interface QuitOutcome {
  readonly ok: boolean;
  /** 只有 `ok` 为 false 时有；已经是可以直接给用户看的一句话。 */
  readonly message?: string;
}

/**
 * 退出：请 core 停下，确认了才真的退出。
 *
 * 失败**不**退出。窗口回来，并把原因告诉用户——另一种做法（照退不误）等于悄悄
 * 把后台服务和用户的会话留在一个没人看过的状态里。
 */
export async function runQuitSequence(
  lifecycle: DesktopLifecycle,
  runtime: RuntimeProcess,
): Promise<QuitOutcome> {
  try {
    await runtime.stop();
  } catch (error) {
    lifecycle.state.quitFailed();
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
  lifecycle.state.quitCompleted();
  return { ok: true };
}

/** 退出没走完时的那段对话框文案。 */
export function quitFailureDialog(message: string): {
  title: string;
  body: string;
} {
  return {
    title: "Armadra 退出未完成",
    body: `后台未能全部停止，应用尚未退出。请检查后台状态。\n${message}`,
  };
}
