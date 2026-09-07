/**
 * 进行中的 merge / rebase / cherry-pick / revert 上能做的三件事：继续、跳过、
 * 中止（Git 工具窗口设计 §2.3 顶部横幅）。
 *
 * 这里只有纯函数。原来这段判断长在 `Integrations.tsx` 的 `resume()` 里，而提交
 * 页的横幅要问的是同一个问题；抄一份的代价是两个地方对「什么时候能继续」各有
 * 一套说法，而这正是「按了继续却什么都没发生」的来源。
 */
import type {
  GitExpectedState,
  GitIntegrationSnapshot,
  GitRepositoryAction,
} from "@armadra/shared";

/** 一次仓库写请求：动作本身，加上它要被比对的那一版 HEAD。 */
export interface RepositoryRequest {
  action: GitRepositoryAction;
  expected: GitExpectedState;
}

/** 三个恢复动作。名字就是按钮上的那三件事。 */
export type IntegrationResume = "continue" | "abort" | "skip";

/**
 * 恢复按钮的文案后缀。只有被本应用接管的种类会走到按钮上，所以 merge 是安全
 * 的兜底——`bisect` 与 `unknown` 永远拿不到 `owned`。
 */
export function recoveryLabel(kind: GitIntegrationSnapshot["kind"]): string {
  return kind === "cherryPick"
    ? "Pick"
    : kind === "rebase"
      ? "Rebase"
      : kind === "revert"
        ? "Revert"
        : "Merge";
}

/** 这个仓库正卡在一次整合里（横幅要不要出现，问的就是它）。 */
export function integrationInProgress(
  state: GitIntegrationSnapshot | null | undefined,
): state is GitIntegrationSnapshot {
  return Boolean(state && state.kind !== "none");
}

/** 「跳过」这个按钮该不该出现：重放为空的 cherry-pick，或者任何 rebase。 */
export function offersSkip(state: GitIntegrationSnapshot): boolean {
  return (
    (state.kind === "cherryPick" && state.empty) || state.kind === "rebase"
  );
}

/**
 * 一次恢复请求，或者 `null`——不属于本应用的会话、缺 sessionId、服务端说
 * 不能继续 / 不能跳过时都得是 `null`，而不是发出去让它被拒。
 */
export function resumeAction(
  state: GitIntegrationSnapshot | null | undefined,
  mode: IntegrationResume,
): RepositoryRequest | null {
  if (!state?.owned || !state.sessionId) return null;
  if (mode === "continue" && !state.canContinue) return null;
  if (mode === "skip" && !state.canSkip) return null;
  return {
    action: {
      kind:
        mode === "abort"
          ? "abortIntegration"
          : mode === "skip"
            ? "skipIntegration"
            : "continueIntegration",
      sessionId: state.sessionId,
      expectedStateToken: state.stateToken,
    },
    expected: { ...state.head },
  };
}

/**
 * 横幅上那句状态。和 `Integrations.tsx` 里的措辞是同一条判断：空的重放、可以
 * 继续、还得先把冲突加进索引，说的是三件不同的事。
 */
export function integrationStatusKey(state: GitIntegrationSnapshot): string {
  if (state.empty) return "gitIntegration.emptyPick";
  if (!state.canContinue) return "gitIntegration.stageFirst";
  return state.kind === "cherryPick"
    ? "gitIntegration.pickReady"
    : state.kind === "rebase"
      ? "gitIntegration.rebaseReady"
      : "gitIntegration.pending";
}
