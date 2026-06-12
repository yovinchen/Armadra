import { AcpSurface } from "../agent/AcpSurface";
import { useCanvasStore } from "../store/canvas-store";
import { NODE_COMMANDS, emitNodeCommand } from "./actions";
import { useNodeCommand } from "./useNodeCommand";
import type { NodeContentProps, OfKind } from "./types";

/** Agent body — the ACP surface owns the header strip, timeline and composer. */
export function AgentNode({ id, data, focused }: NodeContentProps) {
  const updateNode = useCanvasStore((state) => state.updateNode);
  const agent = data as OfKind<"agent">;

  // "↻ 重新协商 ACP": drop the session handle, then start a fresh one.
  useNodeCommand(NODE_COMMANDS.agentRenegotiate, id, () => {
    updateNode(id, { sessionId: undefined, status: "idle" });
    window.setTimeout(() => emitNodeCommand(NODE_COMMANDS.runAgent, id), 0);
  });

  return <AcpSurface id={id} data={agent} focused={focused} />;
}
