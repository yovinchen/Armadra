import * as React from "react";

import { agentSessionRequest } from "@/agent/launch";
import { sessionGateway } from "@/session";
import { useCanvasStore } from "@/store/canvas-store";
import type { SurfaceRefs } from "./refs";
import type { ConnectionStatus } from "./types";

/**
 * 会话的建立：复用节点上记着的那一个，或者新建一个。和 `hello` 的时序绑在
 * 一起，所以 `freshSessionRef` / `launchPhaseRef` 也在这里复位。
 *
 * 两步都经会话网关（业务迁移 §2.6）。挂载先只**读**——这个节点有没有一个
 * 还活着的会话——起不起是第二个决定，由这里在读不到时明确做出。归属在
 * Runtime 还是 Host 由网关判断，调用方不需要知道走了哪一侧。
 *
 * 一个 `lost` 的会话不当成没有：执行主机很可能还留着那个 pane，重新起一个
 * 等于在同一个 pane 上跑第二个程序。所以只有真的读不到、或者读到的已经结束
 * 了，才会走到创建那一步。
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

      if (!forceNew) {
        const existing = await sessionGateway.find(
          workspace.id,
          nodeId,
          nodeData.sessionId,
        );
        if (existing && existing.state === "running") {
          refs.freshSessionRef.current = false;
          setSessionId(existing.sessionId);
          return;
        }
      }

      if (refs.creatingRef.current) return;
      refs.creatingRef.current = true;
      patch({ connection: "starting", error: null });
      try {
        const started = await sessionGateway.start({
          workspaceId: workspace.id,
          nodeId,
          cwd: nodeData.cwd ?? workspace.rootPath,
          ...(nodeData.shell ? { shell: nodeData.shell } : {}),
          // SSH 终端（§21）：只发主机 id，执行主机自己从设置里拼 `ssh …`。
          ...(nodeData.ssh ? { ssh: { hostId: nodeData.ssh.hostId } } : {}),
          ...(nodeData.agent
            ? { agent: agentSessionRequest(nodeData.agent) }
            : {}),
        });
        refs.freshSessionRef.current = true;
        refs.launchPhaseRef.current = "idle";
        useCanvasStore.getState().updateNodeData(nodeId, {
          sessionId: started.sessionId,
          lastExitCode: null,
        });
        setSessionId(started.sessionId);
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
