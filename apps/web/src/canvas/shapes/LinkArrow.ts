import { toast } from "sonner";
import type {
  Editor,
  TLArrowBinding,
  TLArrowShape,
  TLShape,
  TLShapeId,
} from "tldraw";

import { t } from "@/app/preferences-store";
import { isValidLink } from "../connection";
import { contentArrowEnds, ensureContentId } from "../content-links";
import { arrowAiccMeta, arrowEnds } from "../sync/derive";
import { linkRecords } from "../sync/project";
import { isDocumentShapeId, toNodeId } from "./aicc-shape";
import { isLinkShape, type LinkShape } from "./link-shape";

/**
 * 「拉一条箭头 = 一条上下文链接」（tldraw 计划 §4.3）。
 *
 * `TldrawWorkspace` 的 `onMount` 调一次 `registerLinkArrow(editor)`，返回清理函数。
 * 这里管四件事：
 *
 *  1. **换形**：拉线交互仍然走 tldraw 的箭头工具（把手按下 → 切工具 → 放行
 *     事件），但一条 arrow 两端都绑到节点 shape（`aicc` / `frame`）时，交互
 *     结束那一刻把它**换成自定义的 `link` shape + 两条 `link` binding**
 *     （`shapes/LinkShapeUtil.tsx`）。原生箭头的两端锚在节点矩形内部，画出来
 *     是被边框裁掉的直线；`link` 从两个节点相对的边的中点起笔，画的是 v3 那条
 *     贝塞尔。换形与创建在同一个 `editor.run` 里，所以「拉一条线」仍然只占
 *     一条撤销记录。
 *  2. **合法性**：不能自连、同一对不能连两次（无向），规则复用
 *     `canvas/connection.ts` 的 `isValidLink`。
 *  3. **内容链接**：一端绑节点、另一端绑白板 shape（文字 / 形状 / 手绘 / 图片 /
 *     直线 / 高亮 / 画框）的箭头**保留成 tldraw 原生 arrow**，它不是一条
 *     `edges` 行，而是 §6.3 的内容链接：这里只给它写一次方向与颜色，并补上
 *     `meta.aicc.contentId`；读什么、导不导 PNG 归 `canvas/content-links.ts`。
 *  4. **把手兜底**：从把手起笔、松手时**末端一个 shape 都没绑到**的线删掉
 *     （把手是用来连东西的，空放等于取消）；末端绑到任意 shape 都留着。
 *     箭头工具画的没绑定箭头也留着，那是白板内容。
 *  5. **不许被拖走**：`link` 的 `x/y` 钉死在 0（路径是页面坐标），否则用户
 *     选中一条线拖一下，线就和两端脱节了。
 *
 * **为什么判定要推迟到交互结束**（Phase 0 结论 3 + Phase 2）：5.4 的
 * before-create 没有「否决」的返回值；而且箭头工具在**拖动过程中**每一帧都
 * 可能换 binding —— 从节点 A 的把手起笔时指针还在 A 身上，那一刻的「自连」
 * 是中间态，不是用户的意图。
 */

/**
 * 内容链接的箭头颜色。
 *
 * `--brand` 在深色是 `#0a84ff`、浅色是 `#007aff`——两套都是调色板里的那支蓝，
 * 而 tldraw 的 `blue` 自己就跟着明暗主题走，所以这里直接钉在颜色名上，不去读
 * CSS 变量再做一次有损映射。
 */
const CONTENT_ARROW_COLOR = "blue";

/* ------------------------------ 把手起笔标记 ------------------------------- */

/**
 * 把手按下与「下一条被创建的 arrow」之间的一次性标记。
 *
 * `ConnectionHandles` 在 pointerdown 时调 `beginHandleLink()`：它只是切工具然后
 * 放行事件，真正建 arrow 的是 tldraw 的箭头工具（同一次拖动里，可能晚到第一次
 * pointermove 才建）。松手时调 `endHandleLink()` 兜底——只点一下没拖动时不会有
 * arrow 来消费这个标记。
 */
let handleStartPending = false;

export function beginHandleLink(): void {
  handleStartPending = true;
}

export function endHandleLink(): void {
  handleStartPending = false;
}

/** 仅测试用。 */
export function isHandleLinkPending(): boolean {
  return handleStartPending;
}

/* -------------------------------- 形状判定 -------------------------------- */

function isNodeShape(shape: TLShape | undefined): boolean {
  if (!shape) return false;
  if (shape.type === "aicc") return true;
  return shape.type === "frame" && isDocumentShapeId(shape.id);
}

function bindingsOf(editor: Editor, arrowId: TLShapeId): TLArrowBinding[] {
  return editor.getBindingsFromShape<TLArrowBinding>(arrowId, "arrow");
}

/** 画布上现有的节点（`isValidLink` 要确认两端都真实存在）。 */
function currentNodes(editor: Editor): { id: string }[] {
  const nodes: { id: string }[] = [];
  for (const shape of editor.getCurrentPageShapes()) {
    if (isNodeShape(shape)) nodes.push({ id: toNodeId(shape.id) });
  }
  return nodes;
}

/** 画布上现有的边 = 现有的 `link` shape。 */
function currentEdges(editor: Editor): { source: string; target: string }[] {
  const edges: { source: string; target: string }[] = [];
  for (const shape of editor.getCurrentPageShapes()) {
    if (!isLinkShape(shape)) continue;
    const link = shape as LinkShape;
    edges.push({
      source: toNodeId(link.props.from),
      target: toNodeId(link.props.to),
    });
  }
  return edges;
}

/* --------------------------------- 状态机 --------------------------------- */

/**
 * 正在拖 / 正在按着的状态一律不判定：箭头工具在拖动过程中每一帧都可能换 binding，
 * 中间态不代表用户的意图。
 */
const BUSY = /\.(pointing|dragging|translating|resizing|rotating|brushing)/;

function isBusy(editor: Editor): boolean {
  try {
    return BUSY.test(editor.getPath());
  } catch {
    return false;
  }
}

/** 拖到一半被判定成非法时，把整段拖动回滚掉：不进撤销栈，也不进重做栈。 */
function discard(editor: Editor, arrowId: TLShapeId): void {
  editor.bail();
  if (editor.getShape(arrowId)) {
    editor.run(() => editor.deleteShape(arrowId), { history: "ignore" });
  }
}

/* -------------------------------- 注册入口 -------------------------------- */

export function registerLinkArrow(editor: Editor): () => void {
  /** 等着在「交互结束」那一刻判定的 arrow。 */
  const pending = new Set<TLShapeId>();
  /** 从节点把手起笔的 arrow（末端没绑到节点就删掉）。 */
  const fromHandle = new Set<TLShapeId>();
  let retry: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  const schedule = (arrowId: TLShapeId): void => {
    pending.add(arrowId);
    queueMicrotask(flush);
  };

  const flush = (): void => {
    if (disposed || pending.size === 0) return;
    if (isBusy(editor)) {
      // 还在拖：等这次交互结束再判。松手会再触发一次，这里的定时器只是兜底。
      if (retry === null) {
        retry = setTimeout(() => {
          retry = null;
          flush();
        }, 60);
      }
      return;
    }
    const ids = [...pending];
    pending.clear();
    for (const id of ids) evaluate(id);
  };

  const evaluate = (arrowId: TLShapeId): void => {
    const wasHandle = fromHandle.delete(arrowId);
    const arrow = editor.getShape(arrowId) as TLArrowShape | undefined;
    if (!arrow || arrow.type !== "arrow") return;

    const bindings = bindingsOf(editor, arrowId);
    const ends = arrowEnds(arrow, bindings);

    if (!ends.source || !ends.target) {
      // 一端节点、一端白板 shape ⇒ 内容链接（§6.3）：保留成 arrow，写一次样式。
      const content = contentArrowEnds(arrowId, bindings, (id) =>
        editor.getShape(id),
      );
      if (content) {
        styleContentArrow(arrow, content.nodeEnd);
        return;
      }
      // 把手起笔、末端一个 shape 都没绑到 ⇒ 空放，等于取消（§4.3）。
      // 箭头工具画的没绑定箭头留着，那是一条白板箭头。
      const endBound = bindings.some(
        (binding) => binding.props.terminal === "end",
      );
      if (wasHandle && !endBound) discard(editor, arrowId);
      return;
    }

    if (
      !isValidLink(
        { source: ends.source, target: ends.target },
        currentNodes(editor),
        currentEdges(editor),
      )
    ) {
      discard(editor, arrowId);
      toast.error(
        t(ends.source === ends.target ? "edge.selfLink" : "edge.duplicate"),
        { id: "aicc-edge-invalid" },
      );
      return;
    }

    convert(arrow, ends.source, ends.target);
  };

  /**
   * 内容链接的样式：箭头指向节点那一端，颜色取品牌色。
   *
   * `meta.aicc.styled` 与边共用一个标记：写过一次之后用户手改颜色 / 箭头不再被
   * 覆盖。`contentId` 无论如何都要有（`content-links.ts` 靠它定导出文件名）。
   */
  const styleContentArrow = (
    arrow: TLArrowShape,
    nodeEnd: "start" | "end",
  ): void => {
    ensureContentId(editor, arrow);
    // `ensureContentId` 刚写过 meta，手里这份已经旧了。
    const fresh = editor.getShape(arrow.id) ?? arrow;
    const meta = arrowAiccMeta(fresh);
    if (meta.styled) return;
    editor.run(
      () => {
        editor.updateShape({
          id: arrow.id,
          type: "arrow",
          props: {
            color: CONTENT_ARROW_COLOR,
            arrowheadStart: nodeEnd === "start" ? "arrow" : "none",
            arrowheadEnd: nodeEnd === "end" ? "arrow" : "none",
          },
          meta: { ...fresh.meta, aicc: { ...meta, styled: true } },
        } as never);
      },
      { history: "ignore" },
    );
  };

  /**
   * 换形：arrow → `link` shape + 两条 binding。
   *
   * 删旧建新在同一个 `editor.run` 里，中间没有历史标记，所以「拉一条线」
   * 仍然只是一条撤销记录（撤销把线整条拿掉，而不是退回成一条箭头）。
   */
  const convert = (
    arrow: TLArrowShape,
    source: string,
    target: string,
  ): void => {
    const stamp = new Date().toISOString();
    const projection = linkRecords(
      {
        id: crypto.randomUUID(),
        source,
        target,
        kind: "link",
        createdAt: stamp,
        updatedAt: stamp,
      },
      editor.getCurrentPageId(),
    );
    editor.run(() => {
      editor.deleteShape(arrow.id);
      editor.createShape(projection.shape);
      for (const binding of projection.bindings) editor.createBinding(binding);
      // 线走在节点下面：v3 的连线层就在节点层之下，压住终端标题很难看。
      editor.sendToBack([projection.shape.id]);
    });
  };

  const offs = [
    editor.sideEffects.registerAfterCreateHandler("shape", (shape, source) => {
      if (source !== "user" || shape.type !== "arrow") return;
      if (handleStartPending) {
        handleStartPending = false;
        fromHandle.add(shape.id as TLShapeId);
      }
      schedule(shape.id as TLShapeId);
    }),
    editor.sideEffects.registerAfterCreateHandler(
      "binding",
      (binding, source) => {
        if (source !== "user" || binding.type !== "arrow") return;
        schedule(binding.fromId);
      },
    ),
    editor.sideEffects.registerAfterChangeHandler(
      "binding",
      (_prev, next, source) => {
        if (source !== "user" || next.type !== "arrow") return;
        schedule(next.fromId);
      },
    ),
    editor.sideEffects.registerAfterDeleteHandler(
      "binding",
      (binding, source) => {
        if (source !== "user" || binding.type !== "arrow") return;
        schedule(binding.fromId);
      },
    ),
    /*
     * link 的路径是页面坐标，`x/y` 必须一直是 0（`shapes/link-shape.ts`）。
     * 选中一条线拖一下、或者跟着一堆节点被一起 translate，都会写 `x/y`，
     * 这里一律钉回去——线的位置只由两端节点决定。
     */
    editor.sideEffects.registerBeforeChangeHandler("shape", (_prev, next) => {
      if (!isLinkShape(next) || (next.x === 0 && next.y === 0)) return next;
      return { ...next, x: 0, y: 0 };
    }),
  ];

  /** 松手 = 一次交互结束。微任务先跑一次，宏任务兜底（状态机可能晚一拍回位）。 */
  const onPointerRelease = (): void => {
    queueMicrotask(flush);
    setTimeout(flush, 0);
  };
  window.addEventListener("pointerup", onPointerRelease);
  window.addEventListener("pointercancel", onPointerRelease);

  return () => {
    disposed = true;
    if (retry !== null) clearTimeout(retry);
    window.removeEventListener("pointerup", onPointerRelease);
    window.removeEventListener("pointercancel", onPointerRelease);
    for (const off of offs) off();
    pending.clear();
    fromHandle.clear();
    handleStartPending = false;
  };
}
