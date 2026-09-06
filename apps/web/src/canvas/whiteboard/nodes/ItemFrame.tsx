import * as React from "react";
import { NodeResizer } from "@xyflow/react";

import { ConnectionHandles } from "../../flow/nodes/ConnectionHandles";
import { beginGesture, endGesture, resizeItem } from "../store";
import type { Item } from "../model";

/**
 * 白板对象的公共外壳（React Flow 计划 §2.4，归属 whiteboard）。
 *
 * 五种对象共用的四件事：选中框、`NodeResizer`、连线把手，以及「编辑区不许
 * 被画布抢走指针」的 `nodrag` / `nowheel` 约定。
 *
 * 白板对象没有 `flow/drafts.ts` 那条草稿通道（投影 `wb.*` 时不读草稿），
 * 所以 resize 的每一帧都真的写文档；`beginGesture` / `endGesture` 把这一串
 * 合并成一条历史，松手按一下 ⌘Z 回到原来的大小。
 *
 * 把手直接复用节点的 `flow/nodes/ConnectionHandles`（`dropOnly`）：白板对象
 * 与分组的需求逐字相同——不能起笔（对象之间连线是直线 / 箭头工具的活，
 * §2.3 第三行），但必须能当落点（从 Agent 的把手拖过来建一条内容引用），
 * 而且必须有一个 source 锚点，否则 `getEdgePosition` 报 `error008`、整条
 * 引用边一条都画不出来（`source` 恒为白板对象，§2.5）。
 *
 * 两个把手都铺满对象且 `opacity: 0`；落点只在 `useConnection().inProgress`
 * 时接指针事件，锚点永远 `pointer-events: none`。所以平时画一笔、拖一个
 * 形状、双击进文字编辑全都照旧。
 */

/** 白板对象的最小尺寸：再小就点不中，也没法把把手拖回来。 */
export const MIN_ITEM_SIZE = 8;

export interface ItemFrameProps {
  item: Item;
  selected: boolean;
  children: React.ReactNode;
  /** 关掉 resize（直线拖端点，不拖框）。 */
  resizable?: boolean;
  /** 只调宽（文字的高度由内容算）。 */
  widthOnly?: boolean;
  /** 锁比例（图片）。 */
  keepAspectRatio?: boolean;
  className?: string;
}

interface ResizeParams {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface ResizeStart {
  box: { x: number; y: number; w: number; h: number };
  params: ResizeParams;
}

/**
 * 只认 `NodeResizer` 报的**增量**，不认它报的绝对尺寸。
 *
 * 受控画布里 React Flow 的 `measured` 常常是空的：`adoptUserNodes` 每次都
 * 从新的用户节点上取这个字段，而投影出来的节点没有它，只有 ResizeObserver
 * 在像素尺寸真的变了之后才补得回来。起始尺寸被当成 0 时，`params.width`
 * 就等于鼠标走过的距离——直接用它，拖一下把手对象会瞬间缩成一小块。
 *
 * 增量则永远是对的：起手时记下对象自己的矩形与那一刻的 `params`，之后每
 * 一帧只看两者的差。`x` / `y` 是否跟着动，看 `params` 里它们变没变——那正
 * 是「拖的是左边还是右边」的判据。
 */
export function resizedBox(
  start: ResizeStart,
  params: ResizeParams,
  widthOnly: boolean,
): { x: number; y: number; w: number; h: number } {
  const w = Math.max(
    MIN_ITEM_SIZE,
    start.box.w + (params.width - start.params.width),
  );
  const h = widthOnly
    ? start.box.h
    : Math.max(
        MIN_ITEM_SIZE,
        start.box.h + (params.height - start.params.height),
      );
  return {
    x:
      params.x !== start.params.x
        ? start.box.x + (start.box.w - w)
        : start.box.x,
    y:
      params.y !== start.params.y
        ? start.box.y + (start.box.h - h)
        : start.box.y,
    w,
    h,
  };
}

export function ItemFrame({
  item,
  selected,
  children,
  resizable = true,
  widthOnly = false,
  keepAspectRatio = false,
  className,
}: ItemFrameProps) {
  const start = React.useRef<ResizeStart | null>(null);

  const apply = React.useCallback(
    (params: ResizeParams) => {
      if (!start.current) return;
      resizeItem(item.id, resizedBox(start.current, params, widthOnly));
    },
    [item.id, widthOnly],
  );

  return (
    <>
      {resizable ? (
        <NodeResizer
          isVisible={selected}
          // 下限由 `resizedBox` 自己把，交给 React Flow 会连着它那份错的
          // 起始尺寸一起夹，越夹越偏。
          minWidth={0}
          minHeight={0}
          keepAspectRatio={keepAspectRatio}
          onResizeStart={(_event, params) => {
            beginGesture("whiteboard.resize");
            start.current = {
              box: { x: item.x, y: item.y, w: item.w, h: item.h },
              params: { ...params },
            };
          }}
          onResize={(_event, params) => apply(params)}
          onResizeEnd={(_event, params) => {
            apply(params);
            start.current = null;
            endGesture();
          }}
        />
      ) : null}
      <ConnectionHandles dropOnly />
      <div
        className={className}
        data-item-kind={item.kind}
        data-selected={selected ? "true" : undefined}
        style={{
          width: "100%",
          height: "100%",
          position: "relative",
          // 选中框：1.5px 品牌色，与节点卡片的 ring 同一支笔。
          outline: selected ? "1.5px solid var(--brand)" : undefined,
          outlineOffset: 2,
        }}
      >
        {children}
      </div>
    </>
  );
}
