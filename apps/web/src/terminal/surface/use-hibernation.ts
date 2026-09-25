import * as React from "react";
import { toast } from "sonner";

import { t } from "@/app/preferences-store";
import { onWorkspaceEvent } from "@/api/events";
import { sessionGateway } from "@/session";
import { useCanvasStore } from "@/store/canvas-store";
import type { SurfaceRefs } from "./refs";
import type { ConnectionStatus } from "./types";

export interface Hibernation {
  /** 这个节点的会话在节能休眠：不连 socket，等人唤醒。 */
  enter: (sessionId: string) => void;
  /** 点一下 / 聚焦：用 CLI 的 resume 在同一个会话 id 上接回来。 */
  wake: () => void;
}

/**
 * 节能休眠在页面这一侧（终端宿主设计 §7.2）。
 *
 * 状态只有两个来源：挂载时 `find` 读到的那一行（`use-session.ts`），与 core
 * 发的 `terminal.hibernation` 帧——另一台设备先点醒了它、投递叫醒了它，这里都
 * 从帧上知道，而不是自己猜。醒来之后会话 id 不变，只是代次加一，所以接回来就是
 * 照原样重连一次：不新建会话，也不敲启动行（恢复行 core 已经敲过了）。
 */
export function useHibernation(
  refs: SurfaceRefs,
  options: {
    nodeId: string;
    patch: (next: Partial<ConnectionStatus>) => void;
    setSessionId: (id: string) => void;
    setAttempt: React.Dispatch<React.SetStateAction<number>>;
  },
): Hibernation {
  const { nodeId, patch, setSessionId, setAttempt } = options;
  const sessionRef = React.useRef<string | undefined>(undefined);

  const enter = React.useCallback(
    (sessionId: string) => {
      sessionRef.current = sessionId;
      patch({
        connection: "hibernated",
        hibernation: "hibernated",
        binding: null,
        error: null,
      });
    },
    [patch],
  );

  const awake = React.useCallback(
    (sessionId: string) => {
      sessionRef.current = undefined;
      // 恢复行是 core 敲的；这里再敲一遍启动行就是往 CLI 的输入框里打一行命令。
      refs.freshSessionRef.current = false;
      patch({ connection: "connecting", hibernation: null, error: null });
      setSessionId(sessionId);
      setAttempt((value) => value + 1);
    },
    [refs, patch, setSessionId, setAttempt],
  );

  const wake = React.useCallback(() => {
    const status = refs.statusRef.current;
    const sessionId = sessionRef.current;
    if (status.connection !== "hibernated" || sessionId === undefined) return;
    if (status.hibernation === "resuming") return;
    patch({ hibernation: "resuming", error: null });
    const workspaceId = useCanvasStore.getState().workspace?.id ?? "";
    void sessionGateway
      .wake(workspaceId, sessionId)
      .then((record) => awake(record.sessionId))
      .catch((cause: unknown) => {
        patch({
          hibernation: "failed",
          error: cause instanceof Error ? cause.message : String(cause),
        });
        toast.error(t("terminal.hibernation.wakeFailed"));
      });
  }, [refs, patch, awake]);

  React.useEffect(
    () =>
      onWorkspaceEvent("terminal.hibernation", (event) => {
        if (event.nodeId !== nodeId) return;
        const sleeping = refs.statusRef.current.connection === "hibernated";
        switch (event.state) {
          case "hibernated":
            enter(event.sessionId);
            return;
          case "resuming":
            if (sleeping) patch({ hibernation: "resuming" });
            return;
          case "running":
            if (sleeping) awake(event.sessionId);
            return;
          case "failed":
            if (sleeping) patch({ hibernation: "failed" });
            return;
        }
      }),
    [refs, nodeId, enter, awake, patch],
  );

  return { enter, wake };
}
