import { t as translate } from "@/app/preferences-store";
import { agentLabel } from "@/agent/launch";
import { isAutoTitled } from "@/meta/auto-title";
import { useCanvasStore } from "@/store/canvas-store";
import { rememberOscTitle, shouldApplyOscTitle } from "../compat";

/**
 * OSC 0/2 → 节点标题（§18.3 标题行）。用户手动改过名之后就不再覆盖。
 */
export function applyOscTitle(nodeId: string, next: string): void {
  const title = next.trim();
  if (!title) return;
  const store = useCanvasStore.getState();
  const node = store.document?.nodes.find((item) => item.id === nodeId);
  if (!node) return;
  const agentId =
    node.data.kind === "terminal" ? node.data.agent?.id : undefined;
  const defaults = [translate("node.terminal"), agentLabel(agentId)];
  // 自动命名写的是「这个会话在做什么」，OSC 写的是「此刻在跑什么命令」。
  // 让后者冲掉前者，标题会跟着每条命令抖动（Agent 自动化设计 §8 的优先级）。
  if (isAutoTitled(nodeId, node.title)) return;
  if (!shouldApplyOscTitle(nodeId, node.title, defaults)) return;
  if (node.title === title) return;
  rememberOscTitle(nodeId, title);
  store.updateNode(nodeId, { title });
}
