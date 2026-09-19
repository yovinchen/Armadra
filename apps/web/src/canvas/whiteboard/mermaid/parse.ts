import type { Dash } from "../model";

/**
 * Mermaid 文本 → 中间图模型（[Mermaid 导入](../../../../../../docs/design/mermaid-import.md) §2）。
 *
 * mermaid 本体只经 `await import("mermaid")` 进来，所以这个文件即使被静态
 * import 也不会把 2.7 MB 拖进调用方的 chunk（设计 D2）。
 *
 * `db` 的形状不直接外泄：`graphFromDb` 把它收敛成下面这组自己的类型，
 * `layout.ts` 与 `to-items.ts` 因此是纯函数，Mermaid 换版本时只有这一个
 * 文件要跟着改。
 */

export type MermaidDirection = "TB" | "BT" | "LR" | "RL";

/** Mermaid flowchart 的节点形状（实测取值，见设计 §2.1）。裸节点是 `null`。 */
export type MermaidShape =
  | "square"
  | "round"
  | "diamond"
  | "circle"
  | "doublecircle"
  | "stadium"
  | "subroutine"
  | "cylinder"
  | "odd"
  | "hexagon"
  | "trapezoid"
  | "inv_trapezoid"
  | "lean_right"
  | "lean_left"
  | "unknown";

export interface MermaidNode {
  id: string;
  label: string;
  shape: MermaidShape;
  /** `style x fill:#f9f` / `classDef` 解出来的填充色；没有就是 null。 */
  fill: string | null;
}

export interface MermaidEdge {
  from: string;
  to: string;
  label: string;
  arrowStart: boolean;
  arrowEnd: boolean;
  dash: Dash;
}

export interface MermaidGroup {
  id: string;
  label: string;
  nodes: string[];
}

export interface MermaidGraph {
  direction: MermaidDirection;
  nodes: MermaidNode[];
  edges: MermaidEdge[];
  groups: MermaidGroup[];
}

export type MermaidParsed =
  | { kind: "graph"; diagramType: string; graph: MermaidGraph }
  | { kind: "image"; diagramType: string };

/** 解析失败。`line` 是 1 起的行号，拿不到时为 null。 */
export class MermaidParseError extends Error {
  readonly line: number | null;

  constructor(message: string, line: number | null) {
    super(message);
    this.name = "MermaidParseError";
    this.line = line;
  }
}

/* ------------------------------ db 的形状 --------------------------------- */

/**
 * 我们从 flowchart 的 `db` 上要的东西。
 *
 * 写成「全可选」是有意的：Mermaid 将来改名或换实现时，缺方法应该退化成
 * 图片回退，而不是整条路炸掉（设计 §6 第 2 行）。
 */
export interface FlowchartDb {
  getDirection?: () => unknown;
  getVertices?: () => unknown;
  getEdges?: () => unknown;
  getSubGraphs?: () => unknown;
  getClasses?: () => unknown;
}

interface RawVertex {
  id?: unknown;
  text?: unknown;
  type?: unknown;
  styles?: unknown;
  classes?: unknown;
}

interface RawEdge {
  start?: unknown;
  end?: unknown;
  text?: unknown;
  type?: unknown;
  stroke?: unknown;
}

interface RawSubGraph {
  id?: unknown;
  title?: unknown;
  nodes?: unknown;
}

const DIRECTIONS: ReadonlySet<string> = new Set(["TB", "BT", "LR", "RL"]);

const SHAPES: ReadonlySet<string> = new Set([
  "square",
  "round",
  "diamond",
  "circle",
  "doublecircle",
  "stadium",
  "subroutine",
  "cylinder",
  "odd",
  "hexagon",
  "trapezoid",
  "inv_trapezoid",
  "lean_right",
  "lean_left",
]);

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((e) => typeof e === "string") : [];
}

/**
 * `getVertices()` 实测返回 `Map`，但旧版本返回过普通对象。两种都收：
 * 一个 `instanceof` 判断比将来再查一次「为什么导入空了」便宜得多。
 */
function entriesOf(value: unknown): [string, unknown][] {
  if (value instanceof Map) return [...value.entries()];
  if (value && typeof value === "object") return Object.entries(value);
  return [];
}

/** `TD` 是 `TB` 的别名（Mermaid 自己就这么处理）。 */
export function normalizeDirection(value: unknown): MermaidDirection {
  const raw = text(value).toUpperCase();
  if (raw === "TD") return "TB";
  return DIRECTIONS.has(raw) ? (raw as MermaidDirection) : "TB";
}

/** `fill:#f9f` / `fill: #ffaa00` → `#f9f`；没有 fill 就是 null。 */
export function fillFromStyles(styles: readonly string[]): string | null {
  for (const style of styles) {
    const match = /(?:^|;)\s*fill\s*:\s*([^;]+)/i.exec(style);
    const value = match?.[1]?.trim();
    if (value && value.toLowerCase() !== "none") return value;
  }
  return null;
}

/** `arrow_open`（`---`）没有箭头；其余三种（point / cross / circle）都有。 */
function arrowsOf(type: unknown): { arrowStart: boolean; arrowEnd: boolean } {
  const raw = text(type);
  if (!raw || raw === "arrow_open")
    return { arrowStart: false, arrowEnd: false };
  if (raw.startsWith("double_")) return { arrowStart: true, arrowEnd: true };
  return { arrowStart: false, arrowEnd: true };
}

/**
 * `stroke` → 白板的 `dash`。
 *
 * 白板的边没有线宽维度，所以 `thick` 只能降级成实线——这是有损的，但
 * 比凭空加一档样式好（设计 §5）。
 */
export function dashFromStroke(stroke: unknown): Dash {
  return text(stroke) === "dotted" ? "dashed" : "solid";
}

/**
 * `db` → `MermaidGraph`。纯函数：单测可以喂真 db，也可以喂手搓的假 db。
 *
 * 所有读方法都可能不存在或抛，所以每一个都包了一层；拿不到节点时返回
 * null，调用方据此退到图片回退。
 */
export function graphFromDb(db: FlowchartDb): MermaidGraph | null {
  /**
   * 调一个读方法。
   *
   * **必须带上接收者**：mermaid 的 `db` 是类实例，方法体里用 `this`，
   * 把 `db.getVertices` 摘下来单独调会静默拿到空结果（2026-09-19 实测，
   * 整张图会被误判成「不是 flowchart」而退到图片回退）。
   */
  const call = <T>(name: keyof FlowchartDb, fallback: T): unknown => {
    const fn = db[name];
    if (typeof fn !== "function") return fallback;
    try {
      return (fn as () => unknown).call(db);
    } catch {
      return fallback;
    }
  };

  const classStyles = new Map<string, string[]>();
  for (const [name, value] of entriesOf(call("getClasses", {}))) {
    const styles = stringList((value as { styles?: unknown })?.styles);
    if (styles.length > 0) classStyles.set(name, styles);
  }

  const nodes: MermaidNode[] = [];
  for (const [key, value] of entriesOf(call("getVertices", new Map()))) {
    const raw = (value ?? {}) as RawVertex;
    const id = text(raw.id) || key;
    if (!id) continue;
    const shape = text(raw.type);
    // 节点自己的 `style` 压过 `classDef`：Mermaid 的层叠顺序就是这样。
    const own = stringList(raw.styles);
    const viaClass = stringList(raw.classes).flatMap(
      (name) => classStyles.get(name) ?? [],
    );
    nodes.push({
      id,
      // 没写标签的节点（`a --> b`）用 id 当标签，和 Mermaid 渲染一致。
      label: text(raw.text) || id,
      shape: SHAPES.has(shape) ? (shape as MermaidShape) : "unknown",
      fill: fillFromStyles(own) ?? fillFromStyles(viaClass),
    });
  }
  if (nodes.length === 0) return null;

  const known = new Set(nodes.map((node) => node.id));
  const edges: MermaidEdge[] = [];
  for (const value of Array.isArray(call("getEdges", []))
    ? (call("getEdges", []) as RawEdge[])
    : []) {
    const from = text(value.start);
    const to = text(value.end);
    // 指向不存在节点的边画不出来，直接丢：留着会在布局里产出幽灵节点。
    if (!known.has(from) || !known.has(to)) continue;
    edges.push({
      from,
      to,
      label: text(value.text),
      ...arrowsOf(value.type),
      dash: dashFromStroke(value.stroke),
    });
  }

  const groups: MermaidGroup[] = [];
  for (const value of Array.isArray(call("getSubGraphs", []))
    ? (call("getSubGraphs", []) as RawSubGraph[])
    : []) {
    const members = stringList(value.nodes).filter((id) => known.has(id));
    if (members.length === 0) continue;
    const id = text(value.id);
    groups.push({ id, label: text(value.title) || id, nodes: members });
  }

  return {
    direction: normalizeDirection(call("getDirection", "TB")),
    nodes,
    edges,
    groups,
  };
}

/* -------------------------------- 入口 ------------------------------------ */

/** Mermaid 的全局配置。每次解析 / 渲染前都设一遍（设计 §5）。 */
export const MERMAID_CONFIG = {
  startOnLoad: false,
  securityLevel: "strict",
  htmlLabels: false,
  flowchart: { htmlLabels: false },
} as const;

interface MermaidModule {
  initialize: (config: unknown) => void;
  parse: (text: string) => Promise<{ diagramType?: string } | boolean>;
  mermaidAPI: {
    getDiagramFromText: (text: string) => Promise<{ db?: FlowchartDb }>;
  };
}

/** mermaid 只加载一次；`initialize` 每次都调（别的代码可能改过全局配置）。 */
let loading: Promise<MermaidModule> | null = null;

export async function loadMermaid(): Promise<MermaidModule> {
  loading ??= import("mermaid").then(
    (module) => module.default as unknown as MermaidModule,
  );
  const mermaid = await loading;
  mermaid.initialize(MERMAID_CONFIG);
  return mermaid;
}

/** 仅测试用：丢掉缓存的模块，让下一次 `loadMermaid` 重新 import。 */
export function resetMermaidModule(): void {
  loading = null;
}

/** Mermaid 的语法错误 → `MermaidParseError`（保留原话与行号）。 */
export function toParseError(cause: unknown): MermaidParseError {
  const error = cause as { message?: unknown; hash?: { line?: unknown } };
  const message =
    typeof error?.message === "string" && error.message.trim()
      ? error.message.split("\n")[0]!.trim()
      : "Mermaid parse failed";
  // `hash.line` 是 0 起的；显示给人看的行号要 +1。
  const raw = error?.hash?.line;
  const line = typeof raw === "number" && Number.isFinite(raw) ? raw + 1 : null;
  return new MermaidParseError(message, line);
}

/**
 * 唯一的异步入口。
 *
 * 两步：`parse` 先跑（拿图种、抛语法错），`diagramType` 以 `flowchart` 开头
 * 才去取 `db`，否则直接判回退。取 `db` 失败也退回退而不是抛——图本身是
 * 合法的，只是我们转不成原生对象。
 */
export async function parseMermaid(text: string): Promise<MermaidParsed> {
  const mermaid = await loadMermaid();
  let diagramType = "";
  try {
    const result = await mermaid.parse(text);
    if (result && typeof result === "object" && "diagramType" in result) {
      diagramType = String(result.diagramType ?? "");
    }
  } catch (cause) {
    throw toParseError(cause);
  }
  if (!diagramType.startsWith("flowchart") && diagramType !== "graph") {
    return { kind: "image", diagramType };
  }
  try {
    const diagram = await mermaid.mermaidAPI.getDiagramFromText(text);
    const graph = diagram.db ? graphFromDb(diagram.db) : null;
    if (graph) return { kind: "graph", diagramType, graph };
  } catch {
    // 落到回退。
  }
  return { kind: "image", diagramType };
}
