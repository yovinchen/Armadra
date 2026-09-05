import {
  BindingUtil,
  T,
  type BindingOnShapeDeleteOptions,
  type BindingOnShapeIsolateOptions,
  type RecordProps,
} from "tldraw";

import type { LinkBinding, LinkBindingProps } from "./link-shape";

/**
 * link ↔ 节点的绑定（tldraw 计划 §4.3，Phase 3 归属 link-shape）。
 *
 * 一条 link 有两条 binding：`fromId` 是 link shape，`toId` 是节点 shape
 * （`armadra` 或作为分组的 `frame`），`props.terminal` 分辨哪一头。
 *
 * 这里**只管生命周期**：节点被删（或被复制/剪切时与线分离）就把线一起删掉，
 * 不留悬空的半条线。几何不用管——link 的路径是每次从两端 `getShapePageBounds`
 * 现算的（见 `LinkShapeUtil`），节点移动 / resize / 折叠时 tldraw 自己会重绘，
 * 没有任何缓存要在这里同步。
 */
export class LinkBindingUtil extends BindingUtil<LinkBinding> {
  static override type = "link" as const;

  static override props: RecordProps<LinkBinding> = {
    terminal: T.literalEnum("start", "end"),
  };

  override getDefaultProps(): LinkBindingProps {
    return { terminal: "start" };
  }

  /** 节点被删 ⇒ 这条线也没有意义了（派生层随之删掉那条 `edges` 行）。 */
  override onBeforeDeleteToShape({
    binding,
  }: BindingOnShapeDeleteOptions<LinkBinding>): void {
    this.deleteLink(binding);
  }

  /**
   * 只复制/移动了一端（另一端被留下）⇒ 复制出来的线两端对不上，删掉。
   * tldraw 把这种「两个绑定的 shape 被拆开」的情形叫 isolate。
   */
  override onBeforeIsolateToShape({
    binding,
  }: BindingOnShapeIsolateOptions<LinkBinding>): void {
    this.deleteLink(binding);
  }

  private deleteLink(binding: LinkBinding): void {
    if (!this.editor.getShape(binding.fromId)) return;
    this.editor.deleteShape(binding.fromId);
  }
}
