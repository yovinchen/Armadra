import * as React from "react";
import { react, useEditor, type Editor, type TLShapeId } from "tldraw";

import { useT } from "@/app/preferences-store";
import {
  agentHeaderState,
  useAgentStatusStore,
  type AgentGlow,
} from "@/agent/status-store";
import { isDocumentShapeId, toNodeId } from "../shapes/armadra-shape";
import {
  fitPageBounds,
  itemAtPoint,
  minimapFillAlpha,
  minimapPointToPage,
  minimapStroke,
  minimapStrokeWidth,
  minimapZoom,
  rectCenter,
  unionRect,
  type MinimapItem,
  type MinimapPalette,
  type MinimapPoint,
  type MinimapRect,
} from "./minimap";

/**
 * 状态缩略图（tldraw 计划 §3.2，Phase 2「overlays」）。
 *
 * 挂在 `components.Minimap` 上，宿主仍是 tldraw 的 `NavigationPanel`
 * （位置、边框、圆角在 `styles/canvas.css` 里，200×150、右下、水印上方）。
 *
 * 为什么整块自己画而不是叠一层：`MinimapManager` 把整页 shape 合成两条
 * `Path2D` 再各刷一次颜色，颜色只认容器上的 4 个全局变量，**没有**按 shape
 * 上色的入口；叠一层就得把它的相机换算原样抄一遍，抄出来的还是这些代码。
 *
 * 渲染不走 React：`react()` 直接订阅 editor 的信号，相机每帧变化只重画
 * canvas，不触发一次组件更新（`DefaultMinimap` 也是这个路子）。
 */

/** 描边与视口框的粗细（CSS 像素，画的时候按缩放换算回页面单位）。 */
const VIEWPORT_STROKE = 1;

/** 空看板时缩略图里留出的页面区域，免得除以 0。 */
const EMPTY_VIEW: MinimapRect = { x: 0, y: 0, width: 1000, height: 750 };

function readPalette(element: HTMLElement): MinimapPalette {
  const style = getComputedStyle(element);
  const read = (name: string, fallback: string) =>
    style.getPropertyValue(name).trim() || fallback;
  // 注意：这些值最后要喂给 canvas 的 `fillStyle`，所以 `tokens.css` 里
  // 必须是 canvas 认识的颜色。`rgb(… / 55%)` 可以，`color-mix()` 不行
  // （`getPropertyValue` 不会把它算成颜色）——和缩略图旧皮肤同一个坑。
  return {
    working: read("--agent-working", "#d97757"),
    attention: read("--danger", "#ff453a"),
    unread: read("--brand", "#0a84ff"),
    shape: read("--muted-foreground", "#8a8a8a"),
    viewport: read("--active", "rgb(255 255 255 / 12%)"),
    viewportStroke: read("--muted-foreground", "#8a8a8a"),
    background: read("--surface-deep", "#202020"),
  };
}

/** 页面上要画的一切：节点（带状态）在后，白板 shape 在前。 */
function collectItems(
  editor: Editor,
  glowOf: (nodeId: string) => AgentGlow | undefined,
): MinimapItem[] {
  const selected = new Set<string>(editor.getSelectedShapeIds());
  const plain: MinimapItem[] = [];
  const nodes: MinimapItem[] = [];

  for (const id of editor.getCurrentPageShapeIds()) {
    const bounds = editor.getShapeMaskedPageBounds(id);
    if (!bounds) continue;
    const rect: MinimapRect = {
      x: bounds.x,
      y: bounds.y,
      width: bounds.w,
      height: bounds.h,
    };
    const shape = editor.getShape(id);
    if (!shape) continue;
    if (shape.type === "armadra" && isDocumentShapeId(id)) {
      const nodeId = toNodeId(id);
      const glow = glowOf(nodeId);
      nodes.push({
        id: nodeId,
        rect,
        ...(glow ? { glow } : {}),
        selected: selected.has(id),
      });
      continue;
    }
    // 分组 frame、箭头、白板内容：一块低对比的底，不参与状态描边。
    plain.push({ id, rect, plain: true, selected: selected.has(id) });
  }

  return [...plain, ...nodes];
}

interface DrawInput {
  canvas: HTMLCanvasElement;
  items: readonly MinimapItem[];
  viewport: MinimapRect;
  palette: MinimapPalette;
  dpr: number;
}

/** 把一帧画出来，并返回这一帧用的页面区域（点击换算要用同一个）。 */
export function drawMinimap({
  canvas,
  items,
  viewport,
  palette,
  dpr,
}: DrawInput): MinimapRect {
  const rect = canvas.getBoundingClientRect();
  const width = Math.max(Math.round(rect.width), 1);
  const height = Math.max(Math.round(rect.height), 1);
  const content =
    items.reduce<MinimapRect | undefined>(
      (box, item) => unionRect(box, item.rect),
      undefined,
    ) ?? viewport;
  const view = fitPageBounds(
    unionRect(content, viewport) ?? EMPTY_VIEW,
    width / height,
  );
  const zoom = minimapZoom(view, width);

  const ctx = canvas.getContext("2d");
  if (!ctx) return view;

  if (canvas.width !== width * dpr || canvas.height !== height * dpr) {
    canvas.width = width * dpr;
    canvas.height = height * dpr;
  }

  ctx.resetTransform();
  ctx.fillStyle = palette.background;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // 1 页面单位 = zoom * dpr 设备像素，页面区域左上角钉在 canvas 左上角。
  ctx.setTransform(dpr * zoom, 0, 0, dpr * zoom, 0, 0);
  ctx.translate(-view.x, -view.y);

  for (const item of items) {
    const { x, y, width: w, height: h } = item.rect;
    ctx.globalAlpha = minimapFillAlpha(item);
    ctx.fillStyle = palette.shape;
    ctx.fillRect(x, y, w, h);
    ctx.globalAlpha = 1;
    if (item.plain) continue;
    ctx.lineWidth = minimapStrokeWidth(item) / zoom;
    ctx.strokeStyle = minimapStroke(item, palette);
    ctx.strokeRect(x, y, w, h);
  }

  // 视口框最后画，永远在最上面。
  ctx.globalAlpha = 1;
  ctx.fillStyle = palette.viewport;
  ctx.fillRect(viewport.x, viewport.y, viewport.width, viewport.height);
  ctx.lineWidth = VIEWPORT_STROKE / zoom;
  ctx.strokeStyle = palette.viewportStroke;
  ctx.strokeRect(viewport.x, viewport.y, viewport.width, viewport.height);

  return view;
}

export function StatusMinimap() {
  const editor = useEditor();
  const t = useT();
  const canvasRef = React.useRef<HTMLCanvasElement>(null);
  // 指针换算要用「上一帧画的那块区域」，所以画完存下来。
  const viewRef = React.useRef<MinimapRect>(EMPTY_VIEW);
  const itemsRef = React.useRef<readonly MinimapItem[]>([]);
  const draggingRef = React.useRef(false);

  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let palette = readPalette(editor.getContainer());

    const paint = () => {
      const statuses = useAgentStatusStore.getState().statuses;
      const glowOf = (nodeId: string) =>
        agentHeaderState(statuses[nodeId]).glow;
      const items = collectItems(editor, glowOf);
      const bounds = editor.getViewportPageBounds();
      itemsRef.current = items;
      viewRef.current = drawMinimap({
        canvas,
        items,
        viewport: {
          x: bounds.x,
          y: bounds.y,
          width: bounds.width,
          height: bounds.height,
        },
        palette,
        dpr: editor.getInstanceState().devicePixelRatio,
      });
    };

    // `react()` 只跟 editor 的信号走；状态与主题各自订阅一次。
    const stopReaction = react("armadra status minimap", paint);
    const stopStatuses = useAgentStatusStore.subscribe(paint);
    const observer = new ResizeObserver(paint);
    observer.observe(canvas);

    // 主题切换后 CSS 变量才换，颜色要重读一次（`DefaultMinimap` 同款延后）。
    const themeObserver = new MutationObserver(() => {
      editor.timers.setTimeout(() => {
        palette = readPalette(editor.getContainer());
        paint();
      }, 0);
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });

    return () => {
      stopReaction();
      stopStatuses();
      observer.disconnect();
      themeObserver.disconnect();
    };
  }, [editor]);

  /** 缩略图坐标 → 页面坐标（用上一帧的区域换算）。 */
  const pagePointOf = React.useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>): MinimapPoint => {
      const rect = event.currentTarget.getBoundingClientRect();
      return minimapPointToPage(
        { x: event.clientX - rect.left, y: event.clientY - rect.top },
        viewRef.current,
        { width: rect.width, height: rect.height },
      );
    },
    [],
  );

  const onPointerDown = React.useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      if (event.button !== 0) return;
      event.currentTarget.setPointerCapture(event.pointerId);
      draggingRef.current = true;
      const point = pagePointOf(event);
      // 点在某个节点上就居中到那个节点（§3.2「点缩略图定位到节点」），
      // 点在空白处就把相机搬到那个点。
      const hit = itemAtPoint(point, itemsRef.current);
      const target = hit ? rectCenter(hit.rect) : point;
      editor.centerOnPoint(target, { animation: { duration: 200 } });
    },
    [editor, pagePointOf],
  );

  const onPointerMove = React.useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      if (!draggingRef.current) return;
      editor.centerOnPoint(pagePointOf(event));
    },
    [editor, pagePointOf],
  );

  const endDrag = React.useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      draggingRef.current = false;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    },
    [],
  );

  return (
    <div className="tlui-minimap">
      <canvas
        ref={canvasRef}
        role="img"
        aria-label={t("canvas.minimap")}
        data-testid="minimap.canvas"
        className="tlui-minimap__canvas"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      />
    </div>
  );
}

export default StatusMinimap;
