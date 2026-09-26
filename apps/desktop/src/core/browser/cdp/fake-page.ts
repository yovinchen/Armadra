import { SCRIPTS } from "./scripts";
import type { CdpDispatch } from "./session";

/**
 * A scripted page for the verb tests: just enough Chromium to answer the CDP
 * sequences the verbs send, and a record of every command that reached it.
 *
 * Nothing between a verb and this dispatcher is faked — the allowlist, the
 * ref table, the snapshot renderer, the locator — so a test here proves the
 * call sequence and the answer, and `headless/verbs.live.integration.test.ts`
 * proves the same verbs against a real browser.
 *
 * The page is a flat list of elements, each with a backend node id, an
 * accessibility role and name, a box in its frame's viewport, and the state
 * the frozen `elementState` reader would report. A frame other than the page
 * is a child session (a cross-origin iframe) owned by an `Iframe` element.
 */

export interface FakeElement {
  readonly id: number;
  role: string;
  name: string;
  value?: string;
  props?: Record<string, unknown>;
  box: { x: number; y: number; w: number; h: number };
  /** `""` for the page; else a child session id. */
  readonly frame?: string;
  /** What `elementState` says about it, over the defaults. */
  state?: Record<string, unknown>;
  /** `false` hides it from the AX tree (as `ignored`). */
  exposed?: boolean;
  /** Option labels, for a native dropdown's children. */
  options?: string[];
}

export interface Sent {
  readonly method: string;
  readonly params: Record<string, unknown>;
  readonly session: string;
}

const ONE_PIXEL_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

export class FakePage {
  readonly sent: Sent[] = [];
  elements: FakeElement[] = [];
  /** Child session id → the target id (= frame id) and the owning iframe. */
  children = new Map<
    string,
    { targetId: string; owner: number; url: string }
  >();
  url = "https://example.test/a";
  title = "示例";
  viewport = { width: 800, height: 600 };
  content = { width: 800, height: 2_000 };
  scroll = { x: 0, y: 0 };
  history = {
    currentIndex: 1,
    entries: [
      { id: 10, url: "https://example.test/0" },
      { id: 11, url: "https://example.test/a" },
      { id: 12, url: "https://example.test/b" },
    ],
  };
  /** Answers for the document-level frozen scripts, by name. An array is a
   * queue: successive calls get successive answers. */
  scripts: Record<string, unknown> = {};
  /** `selector` → backend node id, for `DOM.querySelector`. */
  selectors: Record<string, number> = {};
  /** Methods that throw, as Chromium would for an unknown node, etc. */
  failing = new Set<string>();
  /** Called after each command, to let a test mutate the page. */
  after?: (sent: Sent) => void;

  readonly dispatch: CdpDispatch = async (method, params, session) => {
    const record = { method, params, session: session ?? "" };
    this.sent.push(record);
    try {
      return this.answer(method, params, session ?? "");
    } finally {
      this.after?.(record);
    }
  };

  methods(): string[] {
    return this.sent.map((each) => each.method);
  }

  element(id: number): FakeElement | undefined {
    return this.elements.find((each) => each.id === id);
  }

  private nodeOf(params: Record<string, unknown>): FakeElement {
    const id =
      typeof params.backendNodeId === "number"
        ? params.backendNodeId
        : typeof params.nodeId === "number"
          ? params.nodeId
          : -1;
    const found = this.element(id);
    if (found === undefined) throw new Error("No node with given id found");
    return found;
  }

  private answer(
    method: string,
    params: Record<string, unknown>,
    session: string,
  ): unknown {
    if (this.failing.has(method)) throw new Error(`${method} failed`);
    switch (method) {
      case "Page.getLayoutMetrics":
        return {
          cssLayoutViewport: {
            clientWidth: this.viewport.width,
            clientHeight: this.viewport.height,
            pageX: this.scroll.x,
            pageY: this.scroll.y,
          },
          cssContentSize: this.content,
          cssVisualViewport: { pageX: this.scroll.x, pageY: this.scroll.y },
        };
      case "Page.getNavigationHistory":
        return this.history;
      case "Page.getFrameTree": {
        if (session !== "") {
          const child = this.children.get(session)!;
          return {
            frameTree: {
              frame: { id: child.targetId, parentId: "main", url: child.url },
            },
          };
        }
        return {
          frameTree: {
            frame: { id: "main", url: this.url },
            childFrames: [...this.children.values()].map((child) => ({
              frame: { id: child.targetId, parentId: "main", url: child.url },
            })),
          },
        };
      }
      case "Accessibility.getFullAXTree":
        return { nodes: this.axTree(session) };
      case "Accessibility.getPartialAXTree": {
        const node = this.nodeOf(params);
        return { nodes: [this.axNode(node)] };
      }
      case "DOM.getFrameOwner": {
        const child = [...this.children.values()].find(
          (each) => each.targetId === params.frameId,
        );
        if (child === undefined) throw new Error("Frame not found");
        return { backendNodeId: child.owner };
      }
      case "DOM.getContentQuads": {
        const node = this.nodeOf(params);
        const { x, y, w, h } = node.box;
        if (w === 0 || h === 0) return { quads: [] };
        return { quads: [[x, y, x + w, y, x + w, y + h, x, y + h]] };
      }
      case "DOM.getBoxModel": {
        const node = this.nodeOf(params);
        const { x, y, w, h } = node.box;
        return { model: { content: [x, y, x + w, y, x + w, y + h, x, y + h] } };
      }
      case "DOM.getDocument":
        return { root: { nodeId: 1 } };
      case "DOM.querySelector": {
        const selector = String(params.selector);
        if (selector.startsWith("!")) throw new Error("not a valid selector");
        return { nodeId: this.selectors[selector] ?? 0 };
      }
      case "DOM.resolveNode": {
        if (params.nodeId === 1) return { object: { objectId: "document" } };
        const node = this.nodeOf(params);
        return { object: { objectId: `node-${node.id}` } };
      }
      case "Runtime.callFunctionOn":
        return { result: { value: this.script(params) } };
      case "Page.navigate":
        this.url = String(params.url);
        return { frameId: "main" };
      case "Page.captureScreenshot":
        return { data: ONE_PIXEL_PNG };
      case "Page.printToPDF":
        return {
          data: Buffer.from(
            "%PDF-1.4\n1 0 obj << /Type /Page >> endobj\n%%EOF",
          ).toString("base64"),
        };
      default:
        return {};
    }
  }

  private script(params: Record<string, unknown>): unknown {
    const declaration = String(params.functionDeclaration);
    const name = Object.entries(SCRIPTS).find(
      ([, body]) => body === declaration,
    )?.[0];
    if (name === undefined)
      throw new Error(
        "a declaration outside the frozen table reached the page",
      );
    const objectId = String(params.objectId);
    if (name === "elementState" || name === "chooseOption") {
      const node = this.element(Number(objectId.replace("node-", "")));
      if (node === undefined) return { found: false };
      if (name === "chooseOption") {
        const picks = String(
          (params.arguments as Array<{ value: unknown }>)[0]?.value,
        )
          .split(",")
          .map(Number);
        if (picks.length > 1 && node.state?.multiple !== true)
          return { ok: false };
        node.state = {
          ...node.state,
          options: (node.options ?? []).map((label, at) => ({
            value: label,
            label,
            selected: picks.includes(at),
          })),
        };
        return { ok: true };
      }
      return {
        found: true,
        tag: "button",
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
        ...node.state,
      };
    }
    const answer = this.scripts[name] ?? this.defaultScript(name);
    if (Array.isArray(answer))
      return answer.length > 1 ? answer.shift() : answer[0];
    return answer;
  }

  private defaultScript(name: string): unknown {
    switch (name) {
      case "readTitle":
        return { title: this.title, url: this.url };
      case "waitProbe":
        return {
          invalid: false,
          present: false,
          visible: false,
          title: this.title,
          url: this.url,
          ready: "complete",
        };
      case "scrollPosition":
        return {
          top: this.scroll.y,
          left: this.scroll.x,
          height: this.content.height,
          width: this.content.width,
          viewportWidth: this.viewport.width,
          viewportHeight: this.viewport.height,
        };
      case "hasText":
        return { found: false };
      default:
        return {};
    }
  }

  private axNode(node: FakeElement): Record<string, unknown> {
    return {
      nodeId: `ax-${node.id}`,
      ignored: node.exposed === false,
      role: { value: node.role },
      name: { value: node.name },
      ...(node.value === undefined ? {} : { value: { value: node.value } }),
      properties: Object.entries(node.props ?? {}).map(([name, value]) => ({
        name,
        value: { value },
      })),
      backendDOMNodeId: node.id,
    };
  }

  /** The AX tree of one frame: a root, and every element of that frame under
   * it, each native dropdown with its options below a popup. */
  private axTree(session: string): Array<Record<string, unknown>> {
    const mine = this.elements.filter((each) => (each.frame ?? "") === session);
    const root = {
      nodeId: `root-${session}`,
      role: { value: "RootWebArea" },
      name: { value: session === "" ? this.title : "" },
      properties: [{ name: "url", value: { value: this.url } }],
      childIds: mine.map((each) => `ax-${each.id}`),
      backendDOMNodeId: 1,
    };
    const nodes: Array<Record<string, unknown>> = [root];
    for (const node of mine) {
      const own = { ...this.axNode(node), parentId: root.nodeId } as Record<
        string,
        unknown
      >;
      if (node.options !== undefined) {
        const popup = `popup-${node.id}`;
        own.childIds = [popup];
        nodes.push({
          nodeId: popup,
          role: { value: "MenuListPopup" },
          parentId: own.nodeId,
          childIds: node.options.map((_, at) => `opt-${node.id}-${at}`),
        });
        node.options.forEach((label, at) =>
          nodes.push({
            nodeId: `opt-${node.id}-${at}`,
            role: { value: "option" },
            name: { value: label },
            parentId: popup,
          }),
        );
      }
      nodes.push(own);
    }
    return nodes;
  }
}
