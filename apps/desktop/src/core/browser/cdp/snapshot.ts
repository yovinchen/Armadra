import type { CdpSession } from "./session";
import { normalizeName, refName } from "./refs";

/**
 * `read --mode snapshot`: the page as a screen reader sees it, one line per
 * thing, with a ref on everything that can be acted on.
 *
 *     - heading "登录" [level=1]
 *     - textbox "邮箱" [ref=e3] [empty]
 *     - combobox "地区" [ref=e4] [value="上海"] [options=北京|上海|广州]
 *     - button "提交" [ref=e5] [disabled]
 *     - iframe "https://pay.example/checkout"
 *       - textbox "卡号" [ref=e6] [empty]
 *
 * Why the accessibility tree and not a CSS query: it is already the page
 * reduced to what a person can perceive and operate — `display:none`,
 * `aria-hidden` and friends are gone before this file sees anything — and a
 * role and an accessible name are what a model can reason about and what a
 * ref can be re-resolved by.
 *
 * Every frame is in it. Same-process iframes are read through the page's own
 * session with their frame id; cross-origin iframes are their own targets,
 * auto-attached as child sessions (`session.ts`), and read through those. The
 * two are stitched together at the `<iframe>` element that owns each frame,
 * which `DOM.getFrameOwner` names.
 *
 * Two rules the renderer keeps that the AX tree does not:
 *
 *   * **An editable field says filled or empty, never its value.** The tree
 *     carries the value of every text box, password fields included (as
 *     bullets); none of it is printed. Nor is anything inside the field.
 *   * **Bounded.** `--max-bytes`, `--depth` and `--interactive` exist so a
 *     long page costs what the caller decided it may.
 */

interface AXValue {
  readonly value?: unknown;
}

interface AXProperty {
  readonly name: string;
  readonly value?: AXValue;
}

export interface AXNode {
  readonly nodeId: string;
  readonly ignored?: boolean;
  readonly role?: AXValue;
  readonly name?: AXValue;
  readonly value?: AXValue;
  readonly properties?: readonly AXProperty[];
  readonly childIds?: readonly string[];
  readonly parentId?: string;
  readonly backendDOMNodeId?: number;
}

interface FrameTree {
  readonly frame: {
    readonly id: string;
    readonly parentId?: string;
    readonly url?: string;
  };
  readonly childFrames?: readonly FrameTree[];
}

/** One document: a frame, the session it is read through, and its AX nodes. */
export interface FrameDoc {
  readonly session: string;
  readonly frameId: string;
  readonly parentFrameId?: string;
  readonly url: string;
  nodes: Map<string, AXNode>;
  rootId?: string;
}

export interface SnapshotOptions {
  readonly interactive: boolean;
  readonly depth?: number;
  readonly maxBytes: number;
}

export interface Snapshot {
  readonly url: string;
  readonly title: string;
  readonly lines: string[];
  readonly refs: number;
  readonly frames: number;
  readonly truncated: boolean;
  /** Lines cut by `--depth` or by the byte cap. */
  readonly omitted: number;
}

/** Roles a person can act on. These get refs. */
export const INTERACTIVE_ROLES: ReadonlySet<string> = new Set([
  "button",
  "link",
  "textbox",
  "searchbox",
  "checkbox",
  "radio",
  "combobox",
  "listbox",
  "option",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "tab",
  "switch",
  "slider",
  "spinbutton",
  "treeitem",
  "DisclosureTriangle",
]);

/** Roles that only group: their children are printed at their depth. */
const TRANSPARENT: ReadonlySet<string> = new Set([
  "generic",
  "paragraph",
  "none",
  "presentation",
  "Section",
  "LayoutTable",
  "LayoutTableRow",
  "LayoutTableCell",
  "LabelText",
  "sectionheader",
  "sectionfooter",
]);

/** Roles never printed, nor anything under them. */
const DROPPED: ReadonlySet<string> = new Set([
  "InlineTextBox",
  "LineBreak",
  "ListMarker",
  "MenuListPopup",
]);

const NAME_LIMIT = 100;
/** Frames read per snapshot. A page with more has ads; ads can wait. */
const MAX_FRAMES = 24;

function str(value: AXValue | undefined): string {
  const raw = value?.value;
  return typeof raw === "string" ? raw : raw === undefined ? "" : String(raw);
}

function roleOf(node: AXNode): string {
  return str(node.role);
}

function nameOf(node: AXNode): string {
  return normalizeName(str(node.name));
}

function prop(node: AXNode, name: string): unknown {
  return node.properties?.find((each) => each.name === name)?.value?.value;
}

function clip(text: string): string {
  return text.length > NAME_LIMIT ? `${text.slice(0, NAME_LIMIT)}…` : text;
}

function flatten(tree: FrameTree, out: FrameTree["frame"][]): void {
  out.push(tree.frame);
  for (const child of tree.childFrames ?? []) flatten(child, out);
}

/**
 * Every document of this page, each with its AX nodes, and the map from an
 * `<iframe>` element to the document it shows.
 */
export async function collectDocs(session: CdpSession): Promise<{
  docs: FrameDoc[];
  owners: Map<string, FrameDoc>;
}> {
  const children = session.childFrames();
  const childTargets = new Set(children.map((child) => child.targetId));
  const docs: FrameDoc[] = [];
  const add = (
    sessionId: string,
    frames: FrameTree["frame"][],
    root: string,
  ) => {
    for (const frame of frames) {
      if (docs.length >= MAX_FRAMES) return;
      // An out-of-process frame is read through its own session, not here.
      if (frame.id !== root && childTargets.has(frame.id)) continue;
      docs.push({
        session: sessionId,
        frameId: frame.id,
        ...(frame.parentId === undefined
          ? {}
          : { parentFrameId: frame.parentId }),
        url: frame.url ?? "",
        nodes: new Map(),
      });
    }
  };
  const main = (await session.send("Page.getFrameTree", {})) as {
    frameTree?: FrameTree;
  };
  if (main.frameTree !== undefined) {
    const frames: FrameTree["frame"][] = [];
    flatten(main.frameTree, frames);
    add("", frames, main.frameTree.frame.id);
  }
  for (const child of children) {
    const tree = (await session
      .send("Page.getFrameTree", {}, child.sessionId)
      .catch(() => undefined)) as { frameTree?: FrameTree } | undefined;
    if (tree?.frameTree === undefined) continue;
    const frames: FrameTree["frame"][] = [];
    flatten(tree.frameTree, frames);
    add(child.sessionId, frames, tree.frameTree.frame.id);
  }

  for (const doc of docs) {
    const answer = (await session
      .send(
        "Accessibility.getFullAXTree",
        { frameId: doc.frameId },
        doc.session,
      )
      .catch(() => undefined)) as { nodes?: AXNode[] } | undefined;
    const nodes = answer?.nodes ?? [];
    doc.nodes = new Map(nodes.map((node) => [node.nodeId, node]));
    doc.rootId = nodes.find((node) => node.parentId === undefined)?.nodeId;
  }

  const byFrame = new Map(docs.map((doc) => [doc.frameId, doc]));
  const owners = new Map<string, FrameDoc>();
  for (const doc of docs) {
    if (doc.parentFrameId === undefined) continue;
    const parent = byFrame.get(doc.parentFrameId);
    if (parent === undefined) continue;
    const owner = (await session
      .send("DOM.getFrameOwner", { frameId: doc.frameId }, parent.session)
      .catch(() => undefined)) as { backendNodeId?: number } | undefined;
    if (typeof owner?.backendNodeId === "number") {
      owners.set(`${parent.session}|${owner.backendNodeId}`, doc);
    }
  }
  return { docs, owners };
}

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
}

/** The address as a snapshot line shows it: short, and never a query. */
function shortUrl(url: string, base: string): string {
  try {
    const parsed = new URL(url, base || undefined);
    const text =
      originOf(base) === parsed.origin
        ? parsed.pathname
        : `${parsed.origin}${parsed.pathname}`;
    return clip(text);
  } catch {
    return clip(url);
  }
}

function states(node: AXNode, role: string): string[] {
  const out: string[] = [];
  const level = prop(node, "level");
  if (role === "heading" && typeof level === "number")
    out.push(`level=${level}`);
  const checked = prop(node, "checked");
  if (checked === "true" || checked === true) out.push("checked");
  else if (checked === "mixed") out.push("mixed");
  if (prop(node, "pressed") === "true" || prop(node, "pressed") === true)
    out.push("pressed");
  if (prop(node, "selected") === true && role !== "option")
    out.push("selected");
  const expanded = prop(node, "expanded");
  if (expanded === true) out.push("expanded");
  else if (expanded === false && role !== "combobox") out.push("collapsed");
  if (prop(node, "disabled") === true) out.push("disabled");
  if (prop(node, "required") === true) out.push("required");
  const invalid = prop(node, "invalid");
  if (typeof invalid === "string" && invalid !== "false") out.push("invalid");
  if (prop(node, "editable") !== undefined) {
    // The one place the AX tree would hand over what somebody typed. It says
    // filled or empty and nothing else — passwords included.
    out.push(str(node.value) === "" ? "empty" : "filled");
  } else {
    const value = str(node.value);
    if (value !== "" && role !== "link" && value !== nameOf(node))
      out.push(`value=${JSON.stringify(clip(normalizeName(value)))}`);
  }
  return out;
}

/** Whether nothing below this node is printed. */
function isLeaf(node: AXNode, role: string): boolean {
  return (
    prop(node, "editable") !== undefined ||
    role === "combobox" ||
    role === "img" ||
    role === "image" ||
    role === "option" ||
    role === "slider" ||
    role === "progressbar" ||
    role === "meter"
  );
}

/** The options of a native dropdown, compactly, for its one line. */
function optionsOf(doc: FrameDoc, node: AXNode): string[] {
  const out: string[] = [];
  const visit = (id: string, depth: number): void => {
    if (depth > 4 || out.length >= 12) return;
    const child = doc.nodes.get(id);
    if (child === undefined) return;
    if (roleOf(child) === "option") {
      out.push(clip(nameOf(child)));
      return;
    }
    for (const next of child.childIds ?? []) visit(next, depth + 1);
  };
  for (const id of node.childIds ?? []) visit(id, 0);
  return out;
}

interface RenderState {
  readonly session: CdpSession;
  readonly owners: Map<string, FrameDoc>;
  readonly options: SnapshotOptions;
  readonly origin: string;
  readonly base: string;
  readonly lines: string[];
  bytes: number;
  refs: number;
  omitted: number;
  full: boolean;
}

function emit(state: RenderState, depth: number, text: string): void {
  if (state.full) {
    state.omitted += 1;
    return;
  }
  const line = `${"  ".repeat(depth)}- ${text}`;
  const size = Buffer.byteLength(line, "utf8") + 1;
  if (state.bytes + size > state.options.maxBytes) {
    state.full = true;
    state.omitted += 1;
    return;
  }
  state.bytes += size;
  state.lines.push(line);
}

function walk(
  state: RenderState,
  doc: FrameDoc,
  id: string,
  depth: number,
  parentName: string,
): void {
  const node = doc.nodes.get(id);
  if (node === undefined) return;
  const role = roleOf(node);
  const children = node.childIds ?? [];
  const deeper = (next: number, name: string): void => {
    for (const child of children) walk(state, doc, child, next, name);
  };
  if (
    node.ignored === true ||
    TRANSPARENT.has(role) ||
    role === "" ||
    // A named group is a group worth a line; an anonymous wrapper is not.
    (role === "group" && nameOf(node) === "")
  ) {
    deeper(depth, parentName);
    return;
  }
  if (DROPPED.has(role)) return;
  if (role === "RootWebArea" || role === "WebArea") {
    deeper(depth, parentName);
    return;
  }
  if (role === "Iframe") {
    const inner =
      node.backendDOMNodeId === undefined
        ? undefined
        : state.owners.get(`${doc.session}|${node.backendDOMNodeId}`);
    if (inner === undefined || inner.rootId === undefined) return;
    if (tooDeep(state, depth)) return;
    emit(
      state,
      depth,
      `iframe ${JSON.stringify(shortUrl(inner.url, state.base))}`,
    );
    walk(state, inner, inner.rootId, depth + 1, "");
    return;
  }
  if (role === "StaticText") {
    if (state.options.interactive) return;
    const text = nameOf(node);
    // A button's label is already its name; printing it twice is tokens.
    if (text === "" || (parentName !== "" && parentName.includes(text))) return;
    // A `<label>`'s text is the name of the field beside it.
    if (labelsSibling(doc, node, text)) return;
    if (tooDeep(state, depth)) return;
    emit(state, depth, `text ${JSON.stringify(clip(text))}`);
    return;
  }
  named(state, doc, node, role, depth, deeper);
}

/** Whether a text is the accessible name of a control in the same group. */
function labelsSibling(doc: FrameDoc, node: AXNode, text: string): boolean {
  const parent =
    node.parentId === undefined ? undefined : doc.nodes.get(node.parentId);
  if (parent === undefined) return false;
  const visit = (id: string, depth: number): boolean => {
    const child = doc.nodes.get(id);
    if (child === undefined || child === node || depth > 3) return false;
    if (INTERACTIVE_ROLES.has(roleOf(child)) && nameOf(child).includes(text))
      return true;
    return (child.childIds ?? []).some((next) => visit(next, depth + 1));
  };
  return (parent.childIds ?? []).some((id) => visit(id, 0));
}

function tooDeep(state: RenderState, depth: number): boolean {
  if (state.options.depth !== undefined && depth >= state.options.depth) {
    state.omitted += 1;
    return true;
  }
  return false;
}

function named(
  state: RenderState,
  doc: FrameDoc,
  node: AXNode,
  role: string,
  depth: number,
  deeper: (next: number, name: string) => void,
): void {
  const name = nameOf(node);
  const interactive = INTERACTIVE_ROLES.has(role);
  if (state.options.interactive && !interactive) {
    // Structure is dropped, not what is inside it.
    deeper(depth, name);
    return;
  }
  if (tooDeep(state, depth)) return;
  let line = role;
  if (name !== "") line += ` ${JSON.stringify(clip(name))}`;
  if (interactive && node.backendDOMNodeId !== undefined) {
    const record = state.session.refs.mint(
      doc.session,
      node.backendDOMNodeId,
      role,
      name,
      state.origin,
    );
    state.refs += 1;
    line += ` [ref=${refName(record.ordinal)}]`;
  }
  for (const each of states(node, role)) line += ` [${each}]`;
  if (role === "link" && !state.options.interactive) {
    const url = prop(node, "url");
    if (typeof url === "string" && url !== "")
      line += ` [url=${shortUrl(url, state.base)}]`;
  }
  if (role === "combobox") {
    const options = optionsOf(doc, node);
    if (options.length > 0) line += ` [options=${options.join("|")}]`;
  }
  emit(state, depth, line);
  if (isLeaf(node, role)) return;
  deeper(state.options.interactive ? depth : depth + 1, name);
}

/** Reads the whole page and renders it. Mints refs as a side effect. */
export async function takeSnapshot(
  session: CdpSession,
  options: SnapshotOptions,
): Promise<Snapshot> {
  const { docs, owners } = await collectDocs(session);
  const top = docs.find(
    (doc) => doc.session === "" && doc.parentFrameId === undefined,
  );
  const root =
    top?.rootId === undefined ? undefined : top.nodes.get(top.rootId);
  const url =
    (root && typeof prop(root, "url") === "string"
      ? (prop(root, "url") as string)
      : top?.url) ?? "";
  const state: RenderState = {
    session,
    owners,
    options,
    origin: originOf(url),
    base: url,
    lines: [],
    bytes: 0,
    refs: 0,
    omitted: 0,
    full: false,
  };
  if (top?.rootId !== undefined) walk(state, top, top.rootId, 0, "");
  const snapshot: Snapshot = {
    url,
    title: root === undefined ? "" : nameOf(root),
    lines: state.lines,
    refs: state.refs,
    frames: docs.length,
    truncated: state.full,
    omitted: state.omitted,
  };
  // Only a whole-page snapshot is a baseline: a diff against the interactive
  // list could not show the status line a click just produced.
  if (!options.interactive && options.depth === undefined && !state.full)
    session.lastSnapshot = {
      interactive: options.interactive,
      generation: session.refs.currentGeneration(),
      lines: state.lines,
    };
  return snapshot;
}

/** One element found by role and name. */
export interface Candidate {
  readonly session: string;
  readonly backendNodeId: number;
  readonly role: string;
  readonly name: string;
}

/**
 * Every element of a role, anywhere on the page, whose accessible name
 * matches. Exact matches win; only when there are none does a
 * case-insensitive substring count. `textbox` also finds `searchbox`, because
 * nobody asking for "the search field" means the distinction.
 */
export async function findByRole(
  session: CdpSession,
  role: string,
  name: string | undefined,
): Promise<{ candidates: Candidate[]; url: string }> {
  const { docs } = await collectDocs(session);
  const wanted = role.toLowerCase();
  const roles =
    wanted === "textbox"
      ? new Set(["textbox", "searchbox"])
      : new Set([wanted]);
  const exact: Candidate[] = [];
  const loose: Candidate[] = [];
  const target = name === undefined ? undefined : normalizeName(name);
  for (const doc of docs) {
    for (const node of doc.nodes.values()) {
      if (node.ignored === true || node.backendDOMNodeId === undefined)
        continue;
      const nodeRole = roleOf(node);
      if (!roles.has(nodeRole.toLowerCase())) continue;
      const nodeName = nameOf(node);
      const candidate = {
        session: doc.session,
        backendNodeId: node.backendDOMNodeId,
        role: nodeRole,
        name: nodeName,
      };
      if (target === undefined || nodeName === target) exact.push(candidate);
      else if (nodeName.toLowerCase().includes(target.toLowerCase()))
        loose.push(candidate);
    }
  }
  const top = docs.find(
    (doc) => doc.session === "" && doc.parentFrameId === undefined,
  );
  return { candidates: exact.length > 0 ? exact : loose, url: top?.url ?? "" };
}

/**
 * What changed between two snapshots, line by line. Lines are compared whole,
 * refs included — which works because an element keeps its ref — and
 * indentation ignored, so an element that only moved is not news.
 */
export function diffLines(
  before: readonly string[],
  after: readonly string[],
): { added: string[]; removed: string[] } {
  const count = new Map<string, number>();
  for (const line of before) {
    const key = line.trim();
    count.set(key, (count.get(key) ?? 0) + 1);
  }
  const added: string[] = [];
  for (const line of after) {
    const key = line.trim();
    const left = count.get(key) ?? 0;
    if (left > 0) count.set(key, left - 1);
    else added.push(key);
  }
  const removed: string[] = [];
  for (const [key, left] of count) {
    for (let i = 0; i < left; i += 1) removed.push(key);
  }
  return { added, removed };
}

export { originOf };
