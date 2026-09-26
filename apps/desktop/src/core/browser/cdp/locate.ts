import { DRIVE_CODES, refuse } from "./codes";
import {
  normalizeName,
  parseRef,
  refName,
  staleRefMessage,
  unknownRefMessage,
  type RefRecord,
} from "./refs";
import type { CdpSession, NodeHandle } from "./session";
import { findByRole, originOf } from "./snapshot";

/**
 * From `--ref` / `--role --name` / `--selector` / `--x --y` to one element
 * and one point in the page's viewport, re-measured right now.
 *
 * The element is a DOM node in one CDP session — the page's, or the one of the
 * cross-origin iframe it lives in. The point is always in the PAGE's
 * coordinates, because input events go to the page: for an element inside an
 * out-of-process iframe, the iframe's own position is added, level by level.
 */

type Args = Record<string, unknown>;

export interface Target {
  /** `""` for the page; else the iframe session the node lives in. */
  readonly session: string;
  /** Absent for a bare point. */
  readonly node?: NodeHandle;
  readonly role: string;
  readonly name: string;
  /** `e12`, when the target is (or became) a ref. */
  readonly ref?: string;
  /** Set when a ref had to be found again; the answer says so. */
  readonly note?: string;
  /** A bare `--x --y`. */
  readonly point?: Point;
}

export interface Point {
  readonly x: number;
  readonly y: number;
}

function text(args: Args, name: string): string | undefined {
  const value = args[name];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function num(args: Args, name: string): number | undefined {
  const value = args[name];
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

/** Whether the caller named an element at all. */
export function hasTarget(args: Args): boolean {
  return (
    text(args, "ref") !== undefined ||
    text(args, "role") !== undefined ||
    text(args, "selector") !== undefined ||
    (num(args, "x") !== undefined && num(args, "y") !== undefined)
  );
}

/** Finds the element the arguments name. Refuses rather than guesses. */
export async function findTarget(
  session: CdpSession,
  args: Args,
): Promise<Target> {
  const x = num(args, "x");
  const y = num(args, "y");
  if (x !== undefined && y !== undefined) {
    return { session: "", role: "point", name: "", point: { x, y } };
  }
  const ref = text(args, "ref");
  if (ref !== undefined) return resolveRef(session, ref);
  const role = text(args, "role");
  if (role !== undefined) return byRole(session, role, text(args, "name"));
  const selector = text(args, "selector");
  if (selector !== undefined) return bySelector(session, selector);
  return refuse(
    DRIVE_CODES.badArgument,
    "请用 --ref、--role [--name]、--selector 或 --x --y 指明目标",
  );
}

/**
 * A value that is a ref when it looks like one and a CSS selector otherwise —
 * `drag` endpoints, where the thing being dragged is often a plain element
 * the snapshot gives no ref to.
 */
export async function refOrSelector(
  session: CdpSession,
  value: string,
): Promise<Target> {
  return parseRef(value) === null
    ? bySelector(session, value)
    : resolveRef(session, value);
}

/** A ref, checked against the element it described and found again if gone. */
export async function resolveRef(
  session: CdpSession,
  value: string,
): Promise<Target> {
  const ordinal = parseRef(value);
  if (ordinal === null)
    refuse(DRIVE_CODES.badArgument, `${value} 不是引用（形如 e12）`);
  const found = session.refs.lookup(ordinal);
  if (!found.ok) {
    if (found.record === undefined)
      refuse(DRIVE_CODES.staleRef, unknownRefMessage(ordinal));
    return reresolve(session, found.record);
  }
  const record = found.record;
  if (record.session !== "" && !session.hasChild(record.session))
    return reresolve(session, record);
  const now = await describeNode(session, record.session, {
    backendNodeId: record.backendNodeId,
  });
  // Same DOM node, same role: the same element, whatever its label says now
  // ("保存" becoming "已保存" is that button doing its job).
  if (now === undefined || now.role !== record.role) {
    session.refs.forget(record);
    return reresolve(session, record);
  }
  if (now.ignored)
    refuse(DRIVE_CODES.notFound, `${refName(ordinal)} 在页面上但不可见`);
  record.name = now.name;
  return {
    session: record.session,
    node: { backendNodeId: record.backendNodeId },
    role: record.role,
    name: now.name,
    ref: refName(ordinal),
  };
}

/** The role and name the accessibility tree gives one node right now. */
async function describeNode(
  session: CdpSession,
  frame: string,
  node: NodeHandle,
): Promise<
  | { role: string; name: string; ignored: boolean; backendNodeId?: number }
  | undefined
> {
  const answer = (await session
    .send(
      "Accessibility.getPartialAXTree",
      { ...node, fetchRelatives: false },
      frame,
    )
    .catch(() => undefined)) as
    | {
        nodes?: Array<{
          ignored?: boolean;
          role?: { value?: unknown };
          name?: { value?: unknown };
          backendDOMNodeId?: number;
        }>;
      }
    | undefined;
  const first = answer?.nodes?.[0];
  if (first === undefined) return undefined;
  return {
    role: String(first.role?.value ?? ""),
    name: normalizeName(String(first.name?.value ?? "")),
    ignored: first.ignored === true,
    ...(typeof first.backendDOMNodeId === "number"
      ? { backendNodeId: first.backendDOMNodeId }
      : {}),
  };
}

/**
 * The one re-resolution: same role, same accessible name, same origin,
 * exactly one element. Anything else is a refusal that says which.
 */
async function reresolve(
  session: CdpSession,
  record: RefRecord,
): Promise<Target> {
  const { candidates, url } = await findByRole(
    session,
    record.role,
    record.name,
  );
  if (record.origin !== "" && originOf(url) !== record.origin)
    refuse(DRIVE_CODES.staleRef, staleRefMessage(record.ordinal, "moved"));
  const exact = candidates.filter(
    (each) => normalizeName(each.name) === normalizeName(record.name),
  );
  if (exact.length === 0)
    refuse(DRIVE_CODES.staleRef, staleRefMessage(record.ordinal, "none"));
  if (exact.length > 1)
    refuse(
      DRIVE_CODES.staleRef,
      staleRefMessage(record.ordinal, "many", exact.length),
    );
  const only = exact[0]!;
  const fresh = session.refs.mint(
    only.session,
    only.backendNodeId,
    only.role,
    only.name,
    originOf(url),
  );
  return {
    session: only.session,
    node: { backendNodeId: only.backendNodeId },
    role: only.role,
    name: only.name,
    ref: refName(fresh.ordinal),
    note: `${refName(record.ordinal)} 已失效，按角色与名称重新定位为 ${refName(fresh.ordinal)}`,
  };
}

/** `--role button --name 提交`: exactly one, or a list to choose from. */
async function byRole(
  session: CdpSession,
  role: string,
  name: string | undefined,
): Promise<Target> {
  const { candidates, url } = await findByRole(session, role, name);
  const what = name === undefined ? role : `${role} ${JSON.stringify(name)}`;
  if (candidates.length === 0)
    refuse(DRIVE_CODES.notFound, `页面上没有 ${what}`);
  const origin = originOf(url);
  const minted = candidates
    .slice(0, 8)
    .map((each) =>
      session.refs.mint(
        each.session,
        each.backendNodeId,
        each.role,
        each.name,
        origin,
      ),
    );
  if (candidates.length > 1) {
    const listed = minted
      .map(
        (record) => `${refName(record.ordinal)} ${JSON.stringify(record.name)}`,
      )
      .join("、");
    refuse(
      DRIVE_CODES.badArgument,
      `有 ${candidates.length} 个 ${what}：${listed}${candidates.length > 8 ? "……" : ""}；请用 --ref 指定一个`,
    );
  }
  const record = minted[0]!;
  return {
    session: record.session,
    node: { backendNodeId: record.backendNodeId },
    role: record.role,
    name: record.name,
    ref: refName(record.ordinal),
  };
}

/** The separator that steps into an open shadow root. */
export const SHADOW_PIERCE = ">>>";

/**
 * A CSS selector, in the main frame's document.
 *
 * `DOM.querySelector` stops at shadow roots, so `host >>> inner` goes through
 * the frozen `shadowQuery` reader instead: each level runs in the OPEN shadow
 * root of what the level before it found. A closed shadow root is out of
 * reach — of page script and of this protocol alike — and the refusal says
 * that is why, instead of claiming the element does not exist.
 */
async function bySelector(
  session: CdpSession,
  selector: string,
): Promise<Target> {
  const nodeId = selector.includes(SHADOW_PIERCE)
    ? await throughShadow(session, selector)
    : await inDocument(session, selector);
  return targetOfNode(session, nodeId);
}

async function inDocument(
  session: CdpSession,
  selector: string,
): Promise<number> {
  const document = (await session.send("DOM.getDocument", { depth: 0 })) as {
    root?: { nodeId?: number };
  };
  const root = document.root?.nodeId;
  if (typeof root !== "number") refuse(DRIVE_CODES.failed, "页面此刻没有文档");
  let nodeId = 0;
  try {
    const found = (await session.send("DOM.querySelector", {
      nodeId: root,
      selector,
    })) as { nodeId?: number };
    nodeId = found.nodeId ?? 0;
  } catch {
    refuse(DRIVE_CODES.badArgument, `${selector} 不是有效的 CSS 选择器`);
  }
  if (nodeId === 0)
    refuse(
      DRIVE_CODES.notFound,
      `页面上没有匹配 ${selector} 的元素（在 Shadow DOM 里的元素用「宿主 ${SHADOW_PIERCE} 里面」的写法）`,
    );
  return nodeId;
}

async function throughShadow(
  session: CdpSession,
  selector: string,
): Promise<number> {
  const levels = selector.split(SHADOW_PIERCE).map((each) => each.trim());
  const found = await session.locateDeep(selector);
  if ("nodeId" in found) return found.nodeId;
  const [kind, at] = found.failure.split(":");
  const level = levels[Number(at)] ?? "";
  if (kind === "closed")
    refuse(
      DRIVE_CODES.notFound,
      `${level} 没有开放的 shadow root（闭合的 shadow root 从页面脚本与调试协议都进不去），找不到 ${selector}`,
    );
  if (kind === "none")
    refuse(
      DRIVE_CODES.notFound,
      Number(at) === 0
        ? `页面上没有匹配 ${level} 的元素`
        : `${levels[Number(at) - 1]} 的 shadow root 里没有匹配 ${level} 的元素`,
    );
  return refuse(
    DRIVE_CODES.badArgument,
    `${selector} 不是有效的选择器：${SHADOW_PIERCE} 两边都要是 CSS 选择器`,
  );
}

async function targetOfNode(
  session: CdpSession,
  nodeId: number,
): Promise<Target> {
  const now = await describeNode(session, "", { nodeId });
  // Held as the BACKEND id: a `nodeId` lives only until the next
  // `DOM.getDocument`, which every frozen read begins with.
  return {
    session: "",
    node:
      now?.backendNodeId === undefined
        ? { nodeId }
        : { backendNodeId: now.backendNodeId },
    role: now?.role ?? "",
    name: now?.name ?? "",
  };
}

/* --------------------------------- points --------------------------------- */

interface FrameTree {
  frame: { id: string; parentId?: string };
  childFrames?: FrameTree[];
}

function frameIds(tree: FrameTree | undefined, out: Set<string>): Set<string> {
  if (tree === undefined) return out;
  out.add(tree.frame.id);
  for (const child of tree.childFrames ?? []) frameIds(child, out);
  return out;
}

/** Which session a frame id is read through. */
async function sessionOfFrame(
  session: CdpSession,
  frameId: string,
): Promise<string | undefined> {
  const children = session.childFrames();
  if (children.some((child) => child.targetId === frameId)) {
    return children.find((child) => child.targetId === frameId)?.sessionId;
  }
  const main = (await session.send("Page.getFrameTree", {})) as {
    frameTree?: FrameTree;
  };
  if (frameIds(main.frameTree, new Set()).has(frameId)) return "";
  for (const child of children) {
    const tree = (await session
      .send("Page.getFrameTree", {}, child.sessionId)
      .catch(() => undefined)) as { frameTree?: FrameTree } | undefined;
    if (frameIds(tree?.frameTree, new Set()).has(frameId))
      return child.sessionId;
  }
  return undefined;
}

/**
 * Where an iframe session's (0, 0) is in the page's viewport. The owning
 * `<iframe>` is scrolled into view first, level by level, so the element
 * inside it has somewhere visible to be.
 */
async function frameOffset(
  session: CdpSession,
  frame: string,
  depth = 0,
): Promise<Point> {
  if (frame === "" || depth > 6) return { x: 0, y: 0 };
  const tree = (await session.send("Page.getFrameTree", {}, frame)) as {
    frameTree?: FrameTree;
  };
  const own = tree.frameTree?.frame;
  if (own?.parentId === undefined)
    refuse(DRIVE_CODES.failed, "找不到这个 iframe 在页面里的位置");
  const parent = await sessionOfFrame(session, own.parentId);
  if (parent === undefined)
    refuse(DRIVE_CODES.failed, "找不到这个 iframe 在页面里的位置");
  const owner = (await session.send(
    "DOM.getFrameOwner",
    { frameId: own.id },
    parent,
  )) as { backendNodeId?: number };
  if (typeof owner.backendNodeId !== "number")
    refuse(DRIVE_CODES.failed, "找不到这个 iframe 在页面里的位置");
  const base = await frameOffset(session, parent, depth + 1);
  await session
    .send(
      "DOM.scrollIntoViewIfNeeded",
      { backendNodeId: owner.backendNodeId },
      parent,
    )
    .catch(() => undefined);
  const box = (await session.send(
    "DOM.getBoxModel",
    { backendNodeId: owner.backendNodeId },
    parent,
  )) as { model?: { content?: number[] } };
  const content = box.model?.content ?? [0, 0];
  return { x: base.x + (content[0] ?? 0), y: base.y + (content[1] ?? 0) };
}

/** The centre of the first non-empty quad of a node, in its frame's viewport. */
async function nodeCentre(
  session: CdpSession,
  target: Target,
): Promise<{
  centre: Point;
  box: { x: number; y: number; w: number; h: number };
}> {
  const node = target.node!;
  await session
    .send("DOM.scrollIntoViewIfNeeded", { ...node }, target.session)
    .catch(() => undefined);
  const answer = (await session
    .send("DOM.getContentQuads", { ...node }, target.session)
    .catch(() => undefined)) as { quads?: number[][] } | undefined;
  const quad = (answer?.quads ?? []).find((each) => area(each) > 1);
  if (quad === undefined)
    refuse(DRIVE_CODES.notFound, `${label(target)} 在页面上但不可见`);
  const xs = [quad[0]!, quad[2]!, quad[4]!, quad[6]!];
  const ys = [quad[1]!, quad[3]!, quad[5]!, quad[7]!];
  const left = Math.min(...xs);
  const top = Math.min(...ys);
  return {
    centre: {
      x: xs.reduce((a, b) => a + b, 0) / 4,
      y: ys.reduce((a, b) => a + b, 0) / 4,
    },
    box: {
      x: left,
      y: top,
      w: Math.max(...xs) - left,
      h: Math.max(...ys) - top,
    },
  };
}

function area(quad: number[]): number {
  if (quad.length < 8) return 0;
  let sum = 0;
  for (let i = 0; i < 4; i += 1) {
    const x1 = quad[i * 2]!;
    const y1 = quad[i * 2 + 1]!;
    const x2 = quad[((i + 1) % 4) * 2]!;
    const y2 = quad[((i + 1) % 4) * 2 + 1]!;
    sum += x1 * y2 - x2 * y1;
  }
  return Math.abs(sum) / 2;
}

/**
 * The point to press, in the page's viewport. Scrolls the element (and every
 * iframe around it) into view first; an element that is still outside the
 * visible page afterwards is refused with that reason.
 */
export async function pointOf(
  session: CdpSession,
  target: Target,
): Promise<Point> {
  const viewport = await session.refreshViewport();
  if (target.point !== undefined) {
    const { x, y } = target.point;
    if (x < 0 || y < 0 || x > viewport.width || y > viewport.height)
      refuse(DRIVE_CODES.badArgument, "那个点在可见区域之外");
    return target.point;
  }
  const offset = await frameOffset(session, target.session);
  const { centre } = await nodeCentre(session, target);
  const point = {
    x: Math.round(centre.x + offset.x),
    y: Math.round(centre.y + offset.y),
  };
  const after = await session.refreshViewport();
  if (
    point.x < 0 ||
    point.y < 0 ||
    point.x > after.width ||
    point.y > after.height
  )
    refuse(DRIVE_CODES.refused, `${label(target)} 在可见区域之外，先滚动过去`);
  return point;
}

/** The element's box in the PAGE's document coordinates, for a clip. */
export async function pageBox(
  session: CdpSession,
  target: Target,
): Promise<{ x: number; y: number; width: number; height: number }> {
  const offset = await frameOffset(session, target.session);
  const { box } = await nodeCentre(session, target);
  const metrics = await session.layoutMetrics();
  return {
    x: box.x + offset.x + metrics.scrollX,
    y: box.y + offset.y + metrics.scrollY,
    width: box.w,
    height: box.h,
  };
}

/** What the element is, as an answer names it: `button "提交" (e5)`. */
export function label(target: Target): string {
  if (target.point !== undefined)
    return `(${target.point.x}, ${target.point.y})`;
  const head =
    target.name === ""
      ? target.role || "元素"
      : `${target.role} ${JSON.stringify(target.name)}`;
  return target.ref === undefined ? head : `${head} (${target.ref})`;
}

/** What the frozen `elementState` reader reports. */
export interface ElementState {
  readonly found: boolean;
  readonly tag: string;
  readonly type: string;
  readonly visible: boolean;
  readonly receives: boolean;
  readonly blocker: string;
  readonly disabled: boolean;
  readonly editable: boolean;
  readonly filled: boolean;
  readonly checkable: boolean;
  readonly checked: boolean;
  readonly isSelect: boolean;
  readonly multiple: boolean;
  readonly options: Array<{ value: string; label: string; selected: boolean }>;
  readonly accepts: boolean;
  readonly focused: boolean;
}

export async function stateOf(
  session: CdpSession,
  target: Target,
): Promise<ElementState> {
  if (target.node === undefined) {
    return {
      found: true,
      tag: "",
      type: "",
      visible: true,
      receives: true,
      blocker: "",
      disabled: false,
      editable: false,
      filled: false,
      checkable: false,
      checked: false,
      isSelect: false,
      multiple: false,
      options: [],
      accepts: false,
      focused: false,
    };
  }
  const state = await session.runOn<ElementState>(
    target.node,
    "elementState",
    undefined,
    target.session,
  );
  if (!state?.found)
    refuse(DRIVE_CODES.staleRef, `${label(target)} 已不在页面上；请重新 read`);
  return state;
}

/**
 * The checks before pressing on something: it is visible, enabled, and it is
 * what is actually under its own centre. A cookie banner over a button is a
 * refusal that names the banner, not a click on the banner.
 */
export async function actionable(
  session: CdpSession,
  target: Target,
): Promise<ElementState> {
  const state = await stateOf(session, target);
  if (!state.visible)
    refuse(DRIVE_CODES.notFound, `${label(target)} 在页面上但不可见`);
  if (state.disabled) refuse(DRIVE_CODES.refused, `${label(target)} 已禁用`);
  if (!state.receives)
    refuse(
      DRIVE_CODES.refused,
      `${label(target)} 被 ${state.blocker || "别的元素"} 挡住了`,
    );
  return state;
}
