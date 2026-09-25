/**
 * 带着预填内容打开快速打开。
 *
 * 单独一个小模块：编辑器节点的「跳转到行」要用它，而快速打开本体连着
 * 语言服务的符号查询，不该为了一个开面板的动作被拖进编辑器的包里。
 */
import { useCanvasStore } from "@/store/canvas-store";

/**
 * 下一次打开时预填的输入，以及 `:行` 该跳哪个文件。「跳转到行」从某个
 * 编辑器里按出来，那个编辑器就是当前文档，而不是「选中的或第一个」。
 */
export interface QuickOpenSeed {
  query: string;
  path?: string;
}

let pending: QuickOpenSeed | null = null;

export function openQuickOpen(seed?: QuickOpenSeed): void {
  pending = seed ?? null;
  useCanvasStore.getState().setPanel("quickOpen", true);
}

/** 快速打开在打开的那一刻取走；取走即清除。 */
export function takeQuickOpenSeed(): QuickOpenSeed | null {
  const seed = pending;
  pending = null;
  return seed;
}
