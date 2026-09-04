import type { Position } from "@armadra/shared";
import {
  Polyline2d,
  SVGContainer,
  ShapeUtil,
  T,
  Vec,
  useEditor,
  useValue,
  type Editor,
  type Geometry2d,
  type RecordProps,
  type TLShapeId,
  type TLShapeUtilCanBindOpts,
} from "tldraw";

import { useT } from "@/app/preferences-store";
import type { Box } from "../geometry";
import { edgeArrowheads, edgeLabelKey } from "../sync/project";
import type { ArmadraShape } from "./armadra-shape";
import { isDocumentShapeId } from "./armadra-shape";
import type { LinkProps, LinkShape } from "./link-shape";
import { linkCurve, sampleCurve, type LinkCurve } from "./link-path";

/**
 * 上下文链接的 shape（tldraw 计划 §4.3，Phase 3 归属 link-shape）。
 *
 * 画法与 v3 的 `FloatingEdge` 一致：从两个节点**相对的边的中点**出发的
 * 贝塞尔（水平切线，只走左右两侧），线宽 2 / 选中 3.5，颜色取起点节点色，
 * 箭头指向「可读端」，中点挂一个标签。几何全部在
 * `shapes/link-path.ts` + `canvas/geometry.ts` 的纯函数里。
 *
 * **不缓存几何**：`x/y` 钉死在 0，路径就是页面坐标，两端节点一动，
 * `getGeometry` / `component` 里读的 `getShapePageBounds` 会被 tldraw 的
 * 响应式系统重新求值（`getShapeGeometry` 是 ComputedCache，
 * shape 组件外层是 `useStateTracking`），所以移动 / resize / 折叠 /
 * 最大化都是自动跟随，link 的记录一个字节都不用改。
 */

/** 线宽：常态 2，选中 3.5（§3.3）。 */
const STROKE_WIDTH = 2;
const STROKE_WIDTH_SELECTED = 3.5;

/** 箭头长度（页面单位，跟着相机缩放）。 */
const ARROW_SIZE = 11;
const ARROW_SPREAD = 0.45;

/** 标签字号与「小于这个缩放就不画」的阈值。 */
const LABEL_FONT_SIZE = 11;
const LABEL_MIN_ZOOM = 0.5;

/* ------------------------------ 端点信息 ---------------------------------- */

export interface LinkEndVisual {
  box: Box;
  /** 节点类型，决定箭头方向与标签。 */
  type: string;
}

/** 一端节点的矩形与类型；不在画布上时返回 null。 */
function endVisual(editor: Editor, id: string): LinkEndVisual | null {
  const shape = editor.getShape(id as TLShapeId);
  if (!shape) return null;
  const bounds = editor.getShapePageBounds(shape.id);
  if (!bounds) return null;
  const box: Box = {
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
  };
  if (shape.type === "armadra") {
    const props = (shape as ArmadraShape).props;
    return { box, type: props.nodeType };
  }
  if (shape.type === "frame" && isDocumentShapeId(shape.id)) {
    return {
      box,
      type: "group",
    };
  }
  return null;
}

export interface LinkView {
  curve: LinkCurve;
  color: string;
  labelKey: string;
  arrowStart: boolean;
  arrowEnd: boolean;
}

/** 画一条 link 需要的全部信息；两端缺一个时返回 null（线马上会被删掉）。 */
export type LinkVisualShape = Pick<LinkShape, "id"> & {
  props: Pick<LinkProps, "from" | "to">;
};

export function linkView(
  editor: Editor,
  shape: LinkVisualShape,
): LinkView | null {
  const source = endVisual(editor, shape.props.from);
  const target = endVisual(editor, shape.props.to);
  if (!source || !target) return null;
  const heads = edgeArrowheads(source.type, target.type);
  return {
    curve: linkCurve(source.box, target.box),
    color: "var(--muted-foreground)",
    labelKey: edgeLabelKey(source.type, target.type),
    arrowStart: heads.start === "arrow",
    arrowEnd: heads.end === "arrow",
  };
}

/* -------------------------------- 箭头 ------------------------------------ */

/** 端点处的一个「V」形箭头（沿曲线切线，不用 SVG marker，省得 id 撞车）。 */
function arrowHead(tip: Position, from: Position): string {
  const dx = tip.x - from.x;
  const dy = tip.y - from.y;
  const length = Math.hypot(dx, dy);
  if (length < 0.001) return "";
  const ux = dx / length;
  const uy = dy / length;
  const barb = (sign: number): Position => {
    const cos = Math.cos(ARROW_SPREAD);
    const sin = Math.sin(ARROW_SPREAD) * sign;
    return {
      x: tip.x - ARROW_SIZE * (ux * cos - uy * sin),
      y: tip.y - ARROW_SIZE * (uy * cos + ux * sin),
    };
  };
  const a = barb(1);
  const b = barb(-1);
  return `M ${a.x},${a.y} L ${tip.x},${tip.y} L ${b.x},${b.y}`;
}

/* ------------------------------- 组件 ------------------------------------- */

export function LinkShapeContent({
  shape,
  transform,
}: {
  shape: LinkVisualShape;
  transform?: string;
}) {
  const editor = useEditor();
  const t = useT();

  const view = useValue("armadra link view", () => linkView(editor, shape), [
    editor,
    shape,
  ]);
  const selected = useValue(
    "armadra link selected",
    () => editor.getSelectedShapeIds().includes(shape.id),
    [editor, shape.id],
  );
  // 缩得太小时标签只剩糊成一团的墨点（§3.3）。
  const showLabel = useValue(
    "armadra link zoom",
    () => editor.getZoomLevel() >= LABEL_MIN_ZOOM,
    [editor],
  );

  if (!view) return null;
  const { curve } = view;
  const color = selected ? "var(--brand)" : view.color;
  const width = selected ? STROKE_WIDTH_SELECTED : STROKE_WIDTH;
  const label = showLabel ? t(view.labelKey) : "";

  return (
    <SVGContainer>
      <g style={{ color }} transform={transform}>
        <path
          d={curve.d}
          fill="none"
          stroke="currentColor"
          strokeWidth={width}
          strokeLinecap="round"
        />
        {view.arrowStart ? (
          <path
            d={arrowHead({ x: curve.sourceX, y: curve.sourceY }, curve.c1)}
            fill="none"
            stroke="currentColor"
            strokeWidth={width}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ) : null}
        {view.arrowEnd ? (
          <path
            d={arrowHead({ x: curve.targetX, y: curve.targetY }, curve.c2)}
            fill="none"
            stroke="currentColor"
            strokeWidth={width}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ) : null}
        {label ? (
          <text
            x={curve.labelX}
            y={curve.labelY}
            textAnchor="middle"
            dominantBaseline="central"
            fontSize={LABEL_FONT_SIZE}
            /*
             * 文字用线自己的颜色（节点色），不用 `--foreground`：画布纸张色
             * 是用户单独选的（`app/use-tldraw-preferences.ts` 直接往 <html>
             * 上写 `--canvas-bg`），深色主题下也可能是一张浅色纸，主题文字色
             * 在那上面会糊掉。描边当底衬，线穿过文字的丑样子也一并解决。
             */
            style={{
              paintOrder: "stroke",
              stroke: "var(--canvas-bg)",
              strokeWidth: 5,
              strokeLinejoin: "round",
              fill: "currentColor",
              fillOpacity: 0.85,
              userSelect: "none",
            }}
          >
            {label}
          </text>
        ) : null}
      </g>
    </SVGContainer>
  );
}

/* ------------------------------- ShapeUtil -------------------------------- */

export class LinkShapeUtil extends ShapeUtil<LinkShape> {
  static override type = "link" as const;

  static override props: RecordProps<LinkShape> = {
    from: T.string,
    to: T.string,
    edgeId: T.string,
    kind: T.literalEnum("link"),
    createdAt: T.string,
    updatedAt: T.string,
  };

  override getDefaultProps(): LinkProps {
    const stamp = new Date().toISOString();
    return {
      from: "",
      to: "",
      edgeId: "",
      kind: "link",
      createdAt: stamp,
      updatedAt: stamp,
    };
  }

  /**
   * 只参与自己那种绑定：两条 `link` binding 的 `fromId` 就是这条线，
   * 所以这里必须放行（`editor.createBinding` 会问两端的 shape util）；
   * 别人的箭头想绑到一条线上则一律拒绝。
   */
  override canBind({ bindingType }: TLShapeUtilCanBindOpts): boolean {
    return bindingType === "link";
  }

  override canResize(): boolean {
    return false;
  }

  override canEdit(): boolean {
    return false;
  }

  override hideResizeHandles(): boolean {
    return true;
  }

  override hideRotateHandle(): boolean {
    return true;
  }

  /** 选中框由 `getIndicatorPath` 沿曲线画，不要那个包围矩形。 */
  override hideSelectionBoundsFg(): boolean {
    return true;
  }

  override hideSelectionBoundsBg(): boolean {
    return true;
  }

  /** 对齐 / 分布 / 整理都不该动它：它的位置完全由两端决定。 */
  override canBeLaidOut(): boolean {
    return false;
  }

  override canCull(): boolean {
    return false;
  }

  /**
   * 沿曲线采样出的折线：命中测试（点线、右键）与选中框都用它。
   * `isFilled` 默认 false，所以只有靠近线本身才算命中。
   */
  override getGeometry(shape: LinkShape): Geometry2d {
    const view = linkView(this.editor, shape);
    if (!view) {
      return new Polyline2d({ points: [new Vec(0, 0), new Vec(0.01, 0)] });
    }
    return new Polyline2d({
      points: sampleCurve(view.curve).map((point) => new Vec(point.x, point.y)),
    });
  }

  override component(shape: LinkShape) {
    return <LinkShapeContent shape={shape} />;
  }

  /** 5.4 的指示器是 `Path2D`（不是 JSX）；同一条曲线，不要另画一条。 */
  override getIndicatorPath(shape: LinkShape): Path2D {
    const path = new Path2D();
    const view = linkView(this.editor, shape);
    if (!view) return path;
    const { curve } = view;
    path.moveTo(curve.sourceX, curve.sourceY);
    path.bezierCurveTo(
      curve.c1.x,
      curve.c1.y,
      curve.c2.x,
      curve.c2.y,
      curve.targetX,
      curve.targetY,
    );
    return path;
  }
}
