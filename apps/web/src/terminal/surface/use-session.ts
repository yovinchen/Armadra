import * as React from "react";

import { runtimeApi } from "@/api/client";
import { agentSessionRequest } from "@/agent/launch";
import { useCanvasStore } from "@/store/canvas-store";
import type { SurfaceRefs } from "./refs";
import type { ConnectionStatus } from "./types";

/**
 * 会话的建立：复用节点上记着的那一个，或者新建一个。和 `hello` 的时序绑在
 * 一起，所以 `freshSessionRef` / `launchPhaseRef` 也在这里复位。
 */
export function useTerminalSession(
  refs: SurfaceRefs,
  options: {
    nodeId: string;
    attempt: number;
    patch: (next: Partial<ConnectionStatus>) => void;
    setSessionId: (id: string) => void;
  },
): (forceNew: boolean) => Promise<void> {
  const { nodeId, attempt, patch, setSessionId } = options;

  const ensureSession = React.useCallback(
    async (forceNew: boolean) => {
      const store = useCanvasStore.getState();
      const workspace = store.workspace;
      if (!workspace) return;
      const node = store.document?.nodes.find((item) => item.id === nodeId);
      const nodeData =
        node && node.data.kind === "terminal"
          ? node.data
          : refs.dataRef.current;

      if (!forceNew && nodeData.sessionId) {
        try {
          const existing = await runtimeApi.getTerminal(nodeData.sessionId);
          if (existing.status === "running") {
            refs.freshSessionRef.current = false;
            setSessionId(existing.id);
            return;
          }
        } catch {
          // 404 / Runtime 重启：往下走，建一个新的
        }
      }

      if (refs.creatingRef.current) return;
      refs.creatingRef.current = true;
      patch({ connection: "starting", error: null });
      try {
        const created = await runtimeApi.createTerminal({
          workspaceId: workspace.id,
          cwd: nodeData.cwd ?? workspace.rootPath,
          args: [],
          nodeId,
          ...(nodeData.shell ? { shell: nodeData.shell } : {}),
          // SSH 终端（§21）：只发主机 id，Runtime 自己从设置里拼 `ssh …`。
          ...(nodeData.ssh ? { ssh: { hostId: nodeData.ssh.hostId } } : {}),
          ...(nodeData.agent
            ? { agent: agentSessionRequest(nodeData.agent) }
            : {}),
        });
        refs.freshSessionRef.current = true;
        refs.launchPhaseRef.current = "idle";
        useCanvasStore.getState().updateNodeData(nodeId, {
          sessionId: created.id,
          lastExitCode: null,
        });
        setSessionId(created.id);
        patch({ connection: "connecting", exitCode: null });
      } catch (cause) {
        patch({
          connection: "failed",
          error: cause instanceof Error ? cause.message : String(cause),
        });
      } finally {
        refs.creatingRef.current = false;
      }
    },
    [refs, nodeId, patch, setSessionId],
  );

  React.useEffect(() => {
    void ensureSession(false);
    // `attempt` 递增 = 用户点了「重新运行」
  }, [attempt, ensureSession]);

  return ensureSession;
}
