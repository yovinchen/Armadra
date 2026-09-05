import * as React from "react";
import {
  HTMLContainer,
  Rectangle2d,
  ShapeUtil,
  T,
  resizeBox,
  useEditor,
  useValue,
  type RecordProps,
  type TLResizeInfo,
} from "tldraw";
import type { CanvasNode } from "@armadra/shared";

import {
  COLLAPSED_HEIGHT,
  NODE_BODY,
  NODE_META,
  NODE_SHELL_SELF,
  type NodeBodyProps,
} from "@/nodes/registry";
import { NodeShell } from "@/nodes/NodeShell";
import { useCanvasNode, useCanvasStore } from "@/store/canvas-store";

import { toNodeId, type ArmadraProps, type ArmadraShape } from "./armadra-shape";

/**
 * 节点 shape（tldraw 计划 §4.1，归属 nodes）。
 *
 * 几何是一个矩形，内容是现有的 `NodeShell` + `NODE_BODY[nodeType]`——节点体
 * 代码一行没动。分组不走这里：分组是 tldraw 原生 frame（§4.2）。
 *
 * Phase 0 结论（照抄，别自己发明）：
 *  - `canCull() => false`：裁剪只是 `display:none`，但终端的 `fit()` 会量到
 *    0×0，回到视口时行列数就错了。
 *  - 不需要「DOM 寄养」：裁剪不卸载组件；`getAppOwnedElement` 留作备用。
 *  - 体内指针事件用 React 合成事件 `stopPropagation`，滚轮分两相——两者都在
 *    `NodeShell` 的节点体上，`ArmadraShapeUtil` 不重复一遍。
 */

/** 选中框的圆角，和 `--r-card` 对齐。 */
const INDICATOR_RADIUS = 10;

/**
 * `shape.props` → `CanvasNode`。
 *
 * **以 shape 为准**：拖动 / resize / 折叠都先落在 tldraw store 上，画布 store
 * 是从它派生出来的，慢一拍。只有 shape 里没有的字段（boardId、parentId、
 * updatedAt）才从画布 store 的那份取。
 */
export function shapeToCanvasNode(
  shape: ArmadraShape,
  stored?: CanvasNode,
): CanvasNode {
  const props = shape.props;
  return {
    id: toNodeId(shape.id),
    boardId: stored?.boardId ?? "",
    type: props.nodeType,
    title: props.title,
    color: props.color,
    position: { x: shape.x, y: shape.y },
    size: { width: props.w, height: props.h },
    collapsed: props.collapsed,
    ...(props.expandedHeight > 0
      ? { expandedHeight: props.expandedHeight }
      : {}),
    ...(stored?.parentId ? { parentId: stored.parentId } : {}),
    labels: props.labels,
    note: props.note,
    data: props.data,
    createdAt: props.createdAt,
    updatedAt: stored?.updatedAt ?? props.createdAt,
  } as CanvasNode;
}

/**
 * 节点内容。写成独立组件而不是内联，是为了能用 hook：选中态要从 editor 订阅
 * （tldraw 的选择是它自己的状态，画布 store 只是投影）。
 */
function ArmadraShapeContent({ shape }: { shape: ArmadraShape }) {
  const editor = useEditor();
  const id = toNodeId(shape.id);
  const nodeType = shape.props.nodeType;

  const selected = useValue(
    "armadra selected",
    () => editor.getSelectedShapeIds().includes(shape.id),
    [editor, shape.id],
  );
  const focused = useCanvasStore((state) => state.focusNodeId === id);
  const stored = useCanvasNode(id);
  const node = React.useMemo(
    () => shapeToCanvasNode(shape, stored),
    [shape, stored],
  );

  const Body = NODE_BODY[nodeType];
  const bodyProps: NodeBodyProps = {
    id,
    node,
    selected,
    collapsed: shape.props.collapsed,
    focused,
  };

  // 头部插槽住在节点体里的类型（终端、编辑器、变更、文件、浏览器）自己渲染
  // `NodeShell`；其余（便签）走通用包壳。
  if (NODE_SHELL_SELF.has(nodeType)) return <Body {...bodyProps} />;

  return (
    <NodeShell node={node} selected={selected}>
      <Body {...bodyProps} />
    </NodeShell>
  );
}

export class ArmadraShapeUtil extends ShapeUtil<ArmadraShape> {
  static override type = "armadra" as const;

  static override props: RecordProps<ArmadraShape> = {
    w: T.number,
    h: T.number,
    nodeType: T.literalEnum(
      "terminal",
      "sticky",
      "editor",
      "diff",
      "files",
      "browser",
    ),
    title: T.string,
    color: T.string,
    collapsed: T.boolean,
    expandedHeight: T.number,
    labels: T.arrayOf(T.string),
    note: T.string,
    // 与 shared 的 zod 校验重复一遍没有意义：文档进来前已经过 zod。
    data: T.any as unknown as RecordProps<ArmadraShape>["data"],
    createdAt: T.string,
  };

  override getDefaultProps(): ArmadraProps {
    return {
      w: NODE_META.terminal.defaultSize.width,
      h: NODE_META.terminal.defaultSize.height,
      nodeType: "terminal",
      title: "",
      color: NODE_META.terminal.defaultColor,
      collapsed: false,
      expandedHeight: 0,
      labels: [],
      note: "",
      data: { kind: "terminal" },
      createdAt: new Date().toISOString(),
    };
  }

  override canCull(): boolean {
    return false;
  }

  override canBind(): boolean {
    return true;
  }

  /** 文字编辑是节点体自己的事（便签、编辑器），tldraw 不接管。 */
  override canEdit(): boolean {
    return false;
  }

  override canResize(): boolean {
    return true;
  }

  /** 选中时用 tldraw 自带的 resize 把手。 */
  override hideResizeHandles(): boolean {
    return false;
  }

  /** 节点不旋转：终端里的文字要保持水平。 */
  override hideRotateHandle(): boolean {
    return true;
  }

  /** 选中框由 `NodeShell` 自己画（1.5px 品牌色 ring），不要再套一层。 */
  override hideSelectionBoundsFg(): boolean {
    return true;
  }

  override getGeometry(shape: ArmadraShape): Rectangle2d {
    return new Rectangle2d({
      width: shape.props.w,
      height: shape.props.h,
      isFilled: true,
    });
  }

  /**
   * 最小尺寸按 `NODE_META[nodeType].minSize`（§3.4 的那张表）。
   * 折叠时高度钉死在 `COLLAPSED_HEIGHT`，且上下边不动——纵向 resize 被禁掉，
   * 拖上下把手只会原地不动，而不是把折叠起来的节点拉成一条长条。
   */
  override onResize(shape: ArmadraShape, info: TLResizeInfo<ArmadraShape>) {
    const next = resizeBox(shape, info);
    const min = NODE_META[shape.props.nodeType].minSize;
    if (shape.props.collapsed) {
      return {
        ...next,
        y: shape.y,
        props: {
          ...next.props,
          w: Math.max(min.width, next.props.w),
          h: COLLAPSED_HEIGHT,
        },
      };
    }
    return {
      ...next,
      props: {
        ...next.props,
        w: Math.max(min.width, next.props.w),
        h: Math.max(min.height, next.props.h),
      },
    };
  }

  override component(shape: ArmadraShape) {
    return (
      // `.tl-html-container` 默认 `pointer-events: none`，要交互必须自己开。
      <HTMLContainer
        style={{
          pointerEvents: "all",
          width: shape.props.w,
          height: shape.props.h,
        }}
      >
        <ArmadraShapeContent shape={shape} />
      </HTMLContainer>
    );
  }

  /** 5.4 把 `indicator(): JSX` 换成了抽象的 `getIndicatorPath(): Path2D`。 */
  override getIndicatorPath(shape: ArmadraShape): Path2D {
    const path = new Path2D();
    path.roundRect(0, 0, shape.props.w, shape.props.h, INDICATOR_RADIUS);
    return path;
  }
}
