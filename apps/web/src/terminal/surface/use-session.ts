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
        // 会话 id 要存盘（重开应用靠它重新贴回同一个 pane），但它不是用户的
        // 编辑：`history: "ignore"` 把它挡在撤销栈外。否则开一块三十个终端的
        // 板子，⌘Z 要按三十次才碰得到自己的第一次改动。
        useCanvasStore
          .getState()
          .updateNodeData(
            nodeId,
            { sessionId: started.sessionId, lastExitCode: null },
            { history: "ignore" },
          );
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

/**
 * 别人替这个节点起了会话：定时任务的冷启动（`LAUNCH_FROZEN`）、依赖满足后
 * core 的 `spawnForNode`。core 把新 id 写进节点数据并发 `board.changed`，合并
 * 进 store 之后这里的 `dataSessionId` 就变了——已经挂着的表面据此换过去，
 * 不用重新挂载才看得见。
 *
 * 只看节点数据**变没变**，不看它和手里那个一不一致：挂载时 `find` 可能找到一个
 * 比节点数据更新的会话，那时两者不同是正常的，不该被拽回旧的。自己新建的会话
 * 同时写了节点数据和本地状态，两边一样，这里什么都不做。正在新建时不抢：那一
 * 次写回会盖掉节点数据，抢过来只会在两个会话之间来回跳。
 *
 * 启动行已经由 core 敲过了，所以换过去的会话不算「本次挂载新建」，不再敲一遍。
 */
export function useAdoptedSession(
  refs: SurfaceRefs,
  options: {
    dataSessionId: string | undefined;
    sessionId: string | undefined;
    patch: (next: Partial<ConnectionStatus>) => void;
    setSessionId: (id: string) => void;
  },
): void {
  const { dataSessionId, sessionId, patch, setSessionId } = options;
  const seenRef = React.useRef(dataSessionId);
  const sessionRef = React.useRef(sessionId);
  sessionRef.current = sessionId;

  React.useEffect(() => {
    if (seenRef.current === dataSessionId) return;
    seenRef.current = dataSessionId;
    if (!dataSessionId || dataSessionId === sessionRef.current) return;
    if (refs.creatingRef.current) return;
    refs.freshSessionRef.current = false;
    refs.launchPhaseRef.current = "idle";
    patch({ connection: "connecting", exitCode: null, error: null });
    setSessionId(dataSessionId);
  }, [refs, dataSessionId, patch, setSessionId]);
}
