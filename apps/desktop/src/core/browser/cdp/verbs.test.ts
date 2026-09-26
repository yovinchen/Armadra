import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { render } from "../render";
import { FakePage, type FakeElement } from "./fake-page";
import { CdpSession } from "./session";
import { runVerbOnHost, type VerbDialog, type VerbHost } from "./verbs";

/**
 * Every verb, one by one, against a scripted page (`fake-page.ts`).
 *
 * The allowlist, the ref table, the snapshot renderer, the locator and the
 * frozen script table are the real ones; what is scripted is Chromium. Each
 * test checks the ANSWER (through `render`, as an Agent reads it) and, where
 * the call sequence is the point, the commands that reached the page.
 */

let page: FakePage;
let session: CdpSession;
let dialog: VerbDialog | undefined;
let chooser: { backendNodeId: number } | undefined;
let temporary = "";
let workspace = "";
const requested: Array<{ action: string; tabId: string; url: string }> = [];
let resized: Array<{ width: number; height: number } | null> = [];
let printed = 0;

function host(extra: Partial<VerbHost> = {}): VerbHost {
  return {
    nodeId: "node-1",
    tabId: "t1",
    session,
    listTabs: () => [
      { id: "t1", active: true, url: page.url, title: page.title },
      { id: "t2", active: false, url: "https://example.test/two", title: "二" },
    ],
    requestTab: async (action, tabId, url) => {
      requested.push({ action, tabId, url });
    },
    listDownloads: () => [],
    acceptDownload: () => ({}),
    rejectDownload: () => ({}),
    pendingChooser: () => chooser,
    clearChooser: () => {
      chooser = undefined;
    },
    openDialog: () => dialog,
    clearDialog: () => {
      dialog = undefined;
    },
    ...extra,
  };
}

async function run(
  verb: string,
  args: Record<string, unknown> = {},
  extra: Partial<VerbHost> = {},
): Promise<string> {
  const result = await runVerbOnHost(host(extra), verb, {
    workspaceRoot: workspace,
    ...args,
  });
  return render(verb, args, result);
}

async function refused(
  verb: string,
  args: Record<string, unknown> = {},
): Promise<{ code: string; message: string }> {
  try {
    await runVerbOnHost(host(), verb, { workspaceRoot: workspace, ...args });
  } catch (error) {
    return {
      code: String((error as { code?: unknown }).code),
      message: (error as Error).message,
    };
  }
  throw new Error(`${verb} was not refused`);
}

function el(
  id: number,
  role: string,
  name: string,
  more: Partial<FakeElement> = {},
): FakeElement {
  return { id, role, name, box: { x: 10, y: id * 30, w: 100, h: 20 }, ...more };
}

beforeEach(async () => {
  page = new FakePage();
  session = new CdpSession(page.dispatch);
  await session.refreshViewport();
  dialog = undefined;
  chooser = undefined;
  requested.length = 0;
  resized = [];
  printed = 0;
  page.elements = [
    el(10, "heading", "登录", { props: { level: 1 } }),
    el(11, "button", "提交"),
    el(12, "textbox", "邮箱", {
      value: "a@b.c",
      props: { editable: "plaintext" },
      state: { tag: "input", editable: true, filled: true },
    }),
    el(13, "textbox", "密码", {
      value: "•••••",
      props: { editable: "plaintext" },
      state: { tag: "input", type: "password", editable: true, filled: true },
    }),
    el(14, "checkbox", "同意", {
      props: { checked: "false" },
      state: {
        tag: "input",
        type: "checkbox",
        checkable: true,
        checked: false,
      },
    }),
    el(15, "combobox", "地区", {
      value: "北京",
      options: ["北京", "上海"],
      state: {
        tag: "select",
        isSelect: true,
        options: [
          { value: "bj", label: "北京", selected: true },
          { value: "sh", label: "上海", selected: false },
        ],
      },
    }),
    el(16, "link", "隐藏", { exposed: false }),
    el(17, "StaticText", "说明文字"),
  ];
  temporary = realpathSync(mkdtempSync(join(tmpdir(), "armadra-cdp-verbs-")));
  workspace = join(temporary, "proj");
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, "a.txt"), "x");
  mkdirSync(join(temporary, "outside"));
  symlinkSync(join(temporary, "outside"), join(workspace, "escape"));
});

afterEach(() => {
  rmSync(temporary, { recursive: true, force: true });
});

/** The ref a snapshot line carries. */
function refIn(text: string, needle: string): string {
  const line = text.split("\n").find((each) => each.includes(needle));
  const ref = /\[ref=(e\d+)\]/.exec(line ?? "")?.[1];
  if (ref === undefined) throw new Error(`no ref for ${needle}:\n${text}`);
  return ref;
}

/* -------------------------------- read ------------------------------------ */

describe("read --mode snapshot", () => {
  it("is the default, and prints roles, names, refs and states", async () => {
    const text = await run("read");
    expect(text).toContain("页面：示例 — https://example.test/a");
    expect(text).toContain('- heading "登录" [level=1]');
    expect(text).toMatch(/- button "提交" \[ref=e\d+\]/);
    expect(text).toMatch(/- checkbox "同意" \[ref=e\d+\]\n/);
    expect(text).toContain('[value="北京"] [options=北京|上海]');
    expect(text).toContain('- text "说明文字"');
  });

  it("says filled or empty for a field and never its value, passwords included", async () => {
    const text = await run("read");
    expect(text).toMatch(/textbox "邮箱" \[ref=e\d+\] \[filled\]/);
    expect(text).not.toContain("a@b.c");
    expect(text).not.toContain("•");
  });

  it("leaves out what the accessibility tree ignores", async () => {
    expect(await run("read")).not.toContain("隐藏");
  });

  it("keeps an element's ref from one snapshot to the next", async () => {
    const first = refIn(await run("read"), '"提交"');
    const second = refIn(await run("read", { interactive: true }), '"提交"');
    expect(second).toBe(first);
  });

  it("--interactive lists only what can be acted on", async () => {
    const text = await run("read", { interactive: true });
    expect(text).not.toContain("heading");
    expect(text).not.toContain("说明文字");
    expect(text).toContain("button");
  });

  it("--max-bytes cuts and says so", async () => {
    const text = await run("read", { maxBytes: 512 });
    expect(text.length).toBeLessThan(1_200);
    page.elements = Array.from({ length: 80 }, (_, at) =>
      el(100 + at, "button", `按钮${at}`),
    );
    const long = await run("read", { maxBytes: 600 });
    expect(long).toContain("已截断");
  });

  it("--depth stops expanding and counts what it left", async () => {
    const text = await run("read", { depth: 1 });
    expect(text).toContain("heading");
  });

  it("reads into a cross-origin iframe through its own session", async () => {
    page.elements.push(el(20, "Iframe", ""));
    page.elements.push(el(21, "button", "跨源按钮", { frame: "child-1" }));
    page.children.set("child-1", {
      targetId: "frame-x",
      owner: 20,
      url: "https://other.test/x",
    });
    session.noteEvent("Target.attachedToTarget", {
      sessionId: "child-1",
      targetInfo: {
        type: "iframe",
        targetId: "frame-x",
        url: "https://other.test/x",
      },
    });
    const text = await run("read");
    expect(text).toContain('- iframe "https://other.test/x"');
    expect(text).toMatch(/ {2}- button "跨源按钮" \[ref=e\d+\]/);
    expect(
      page.sent.some(
        (each) =>
          each.session === "child-1" &&
          each.method === "Accessibility.getFullAXTree",
      ),
    ).toBe(true);
  });

  it("text, title and links are still there", async () => {
    page.scripts.readText = {
      text: "正文",
      total: 2,
      truncated: false,
      title: "示例",
      url: page.url,
    };
    expect(await run("read", { mode: "text" })).toContain("正文");
    expect(await run("read", { mode: "title" })).toContain("标题：示例");
    page.scripts.readLinks = {
      links: [{ name: "下一页", href: "https://example.test/n" }],
      url: page.url,
    };
    expect(await run("read", { mode: "links" })).toContain(
      "下一页 → https://example.test/n",
    );
  });

  it("refuses a mode that does not exist", async () => {
    expect((await refused("read", { mode: "evaluate" })).code).toBe(
      "browser_bad_argument",
    );
  });
});

describe("read --mode console / network", () => {
  it("keeps console entries by level, and exceptions", async () => {
    session.noteEvent("Runtime.consoleAPICalled", {
      type: "log",
      args: [
        { type: "string", value: "你好" },
        { type: "number", value: 1 },
      ],
    });
    session.noteEvent("Runtime.consoleAPICalled", {
      type: "error",
      args: [{ type: "string", value: "坏了" }],
      stackTrace: {
        callFrames: [
          { url: "https://example.test/app.js?token=zzz", lineNumber: 9 },
        ],
      },
    });
    session.noteEvent("Runtime.exceptionThrown", {
      exceptionDetails: { exception: { description: "TypeError: x" } },
    });
    session.noteEvent("Log.entryAdded", {
      entry: { level: "warning", source: "network", text: "慢" },
    });
    const all = await run("read", { mode: "console" });
    expect(all).toContain("[log] 你好 1");
    expect(all).toContain(
      "[error] 坏了  (https://example.test/app.js?token=%E2%80%A6:10)",
    );
    expect(all).toContain("[error exception] TypeError: x");
    expect(all).not.toContain("zzz");
    const errors = await run("read", { mode: "console", level: "error" });
    expect(errors).not.toContain("你好");
    expect(errors).not.toContain("慢");
    expect(
      (await refused("read", { mode: "console", level: "loud" })).code,
    ).toBe("browser_bad_argument");
    await run("read", { mode: "console", clear: true });
    expect(await run("read", { mode: "console" })).toContain("没有符合条件");
  });

  it("keeps request metadata only: no headers, no cookies, no secrets in the address", async () => {
    session.noteEvent("Network.requestWillBeSent", {
      requestId: "1",
      type: "Fetch",
      timestamp: 1,
      request: {
        method: "POST",
        url: "https://api.test/v1?session=abc&page=2#frag",
        headers: { Authorization: "Bearer SECRET", Cookie: "sid=1" },
        postData: "password=hunter2",
      },
    });
    session.noteEvent("Network.responseReceived", {
      requestId: "1",
      type: "Fetch",
      response: {
        status: 201,
        mimeType: "application/json",
        headers: { "Set-Cookie": "sid=2" },
      },
    });
    session.noteEvent("Network.loadingFinished", {
      requestId: "1",
      timestamp: 1.25,
      encodedDataLength: 2048,
    });
    session.noteEvent("Network.requestWillBeSent", {
      requestId: "2",
      type: "Script",
      timestamp: 2,
      request: { method: "GET", url: "https://cdn.test/a.js" },
    });
    session.noteEvent("Network.loadingFailed", {
      requestId: "2",
      timestamp: 2.1,
      errorText: "net::ERR_FAILED",
    });
    const text = await run("read", { mode: "network" });
    expect(text).toContain(
      "POST 201 fetch 2.0 KB 250 ms https://api.test/v1?session=%E2%80%A6&page=2",
    );
    expect(text).toContain("GET 失败(net::ERR_FAILED) script");
    for (const secret of ["SECRET", "sid=", "hunter2", "abc", "frag"])
      expect(text).not.toContain(secret);
    expect(await run("read", { mode: "network", failed: true })).not.toContain(
      "POST",
    );
    expect(await run("read", { mode: "network", type: "fetch" })).not.toContain(
      "a.js",
    );
    expect(await run("read", { mode: "network", filter: "cdn" })).not.toContain(
      "api.test",
    );
  });
});

/* ------------------------------- targeting -------------------------------- */

describe("click and targeting", () => {
  it("clicks a ref at the centre of its box, and reports the address after", async () => {
    const ref = refIn(await run("read"), '"提交"');
    page.sent.length = 0;
    const text = await run("click", { ref });
    expect(text).toContain(`已点击 button "提交" (${ref})`);
    expect(text).toContain("地址：https://example.test/a");
    const pressed = page.sent.find(
      (each) => each.params.type === "mousePressed",
    );
    expect(pressed?.params).toMatchObject({ x: 60, y: 340 });
  });

  it("finds by role and name, and asks which one when there are several", async () => {
    expect(await run("click", { role: "button", name: "提交" })).toContain(
      "已点击",
    );
    page.elements.push(el(30, "button", "提交"));
    const many = await refused("click", { role: "button", name: "提交" });
    expect(many.code).toBe("browser_bad_argument");
    expect(many.message).toMatch(
      /有 2 个 button "提交"：e\d+ "提交"、e\d+ "提交"/,
    );
    expect(
      (await refused("click", { role: "button", name: "没有" })).code,
    ).toBe("browser_not_found");
  });

  it("finds a CSS selector in the main frame", async () => {
    page.selectors["#go"] = 11;
    expect(await run("click", { selector: "#go" })).toContain('button "提交"');
    expect((await refused("click", { selector: "#nope" })).code).toBe(
      "browser_not_found",
    );
    expect((await refused("click", { selector: "!bad" })).code).toBe(
      "browser_bad_argument",
    );
  });

  it("re-finds a ref whose node is gone by role and name, exactly once", async () => {
    const ref = refIn(await run("read"), '"提交"');
    page.elements = page.elements.map((each) =>
      each.id === 11 ? { ...each, id: 40 } : each,
    );
    const text = await run("click", { ref });
    expect(text).toMatch(
      new RegExp(`${ref} 已失效，按角色与名称重新定位为 e\\d+`),
    );
  });

  it("refuses a gone ref that now matches nothing, or several", async () => {
    const ref = refIn(await run("read"), '"提交"');
    page.elements = page.elements.filter((each) => each.id !== 11);
    expect((await refused("click", { ref })).message).toContain(
      "也没找到同样的元素",
    );
    const second = refIn(await run("read"), '"同意"');
    page.elements = page.elements.filter((each) => each.id !== 14);
    page.elements.push(el(50, "checkbox", "同意"), el(51, "checkbox", "同意"));
    const many = await refused("click", { ref: second });
    expect(many.code).toBe("browser_stale_ref");
    expect(many.message).toContain("找到 2 个");
  });

  it("does not follow a ref to another site after a navigation", async () => {
    const ref = refIn(await run("read"), '"提交"');
    session.noteEvent("Page.frameNavigated", { frame: { id: "main" } });
    page.url = "https://elsewhere.test/";
    const moved = await refused("click", { ref });
    expect(moved.code).toBe("browser_stale_ref");
    expect(moved.message).toContain("另一个站点");
  });

  it("refuses a ref it never handed out", async () => {
    expect((await refused("click", { ref: "e999" })).message).toContain(
      "不是这个页面给出的引用",
    );
    expect((await refused("click", { ref: "button" })).code).toBe(
      "browser_bad_argument",
    );
  });

  it("refuses a disabled control, a covered one, and one with no box", async () => {
    page.elements.find((each) => each.id === 11)!.state = { disabled: true };
    expect(
      (await refused("click", { role: "button", name: "提交" })).message,
    ).toContain("已禁用");
    page.elements.find((each) => each.id === 11)!.state = {
      receives: false,
      blocker: 'div "Cookie 横幅"',
    };
    expect(
      (await refused("click", { role: "button", name: "提交" })).message,
    ).toContain('被 div "Cookie 横幅" 挡住了');
    page.elements.find((each) => each.id === 11)!.box = {
      x: 0,
      y: 0,
      w: 0,
      h: 0,
    };
    expect(
      (await refused("click", { role: "button", name: "提交" })).code,
    ).toBe("browser_not_found");
  });

  it("refuses a point outside the page and one still outside after scrolling", async () => {
    expect((await refused("click", { x: 5_000, y: 5 })).code).toBe(
      "browser_bad_argument",
    );
    page.elements.find((each) => each.id === 11)!.box = {
      x: 10,
      y: 5_000,
      w: 80,
      h: 20,
    };
    expect(
      (await refused("click", { role: "button", name: "提交" })).message,
    ).toContain("先滚动过去");
  });

  it("clicks inside a cross-origin iframe at the iframe's offset", async () => {
    page.elements.push(
      el(20, "Iframe", "", { box: { x: 100, y: 200, w: 300, h: 150 } }),
    );
    page.elements.push(
      el(21, "button", "跨源按钮", {
        frame: "child-1",
        box: { x: 10, y: 10, w: 40, h: 20 },
      }),
    );
    page.children.set("child-1", {
      targetId: "frame-x",
      owner: 20,
      url: "https://other.test/x",
    });
    session.noteEvent("Target.attachedToTarget", {
      sessionId: "child-1",
      targetInfo: {
        type: "iframe",
        targetId: "frame-x",
        url: "https://other.test/x",
      },
    });
    await run("click", { role: "button", name: "跨源按钮" });
    const pressed = page.sent.find(
      (each) => each.params.type === "mousePressed",
    );
    expect(pressed?.params).toMatchObject({ x: 130, y: 220 });
    expect(pressed?.session).toBe("");
  });

  it("double-clicks with --double", async () => {
    await run("click", { role: "button", name: "提交", double: true });
    const counts = page.sent
      .filter((each) => each.params.type === "mousePressed")
      .map((each) => each.params.clickCount);
    expect(counts).toEqual([1, 2]);
  });

  it("answers with a diff when asked for --snapshot", async () => {
    await run("read");
    page.after = (sent) => {
      if (sent.params.type === "mouseReleased")
        page.elements.push(el(60, "StaticText", "已提交"));
    };
    const text = await run("click", {
      role: "button",
      name: "提交",
      snapshot: true,
    });
    expect(text).toContain('页面变化：\n+ text "已提交"');
    page.after = undefined;
    expect(
      await run("click", { role: "button", name: "提交", snapshot: true }),
    ).toContain("页面快照没有变化");
  });
});

/* ------------------------------ other input -------------------------------- */

describe("hover and drag", () => {
  it("hover only moves the pointer", async () => {
    expect(await run("hover", { role: "button", name: "提交" })).toContain(
      '指针已移到 button "提交"',
    );
    expect(
      page.sent
        .filter((each) => each.method === "Input.dispatchMouseEvent")
        .every((each) => each.params.type === "mouseMoved"),
    ).toBe(true);
  });

  it("drag presses, travels and releases; an HTML5 drag is dropped with the page's own data", async () => {
    page.selectors["#a"] = 11;
    page.selectors["#b"] = 14;
    page.after = (sent) => {
      if (
        sent.params.type === "mouseMoved" &&
        sent.params.buttons === 1 &&
        session.interceptedDrag === undefined
      )
        session.noteEvent("Input.dragIntercepted", {
          data: {
            items: [{ mimeType: "text/plain", data: "x" }],
            dragOperationsMask: 1,
          },
        });
    };
    const text = await run("drag", { from: "#a", to: "#b" });
    expect(text).toContain('已把 button "提交" 拖到 checkbox "同意"');
    const methods = page.methods();
    expect(methods).toContain("Input.setInterceptDrags");
    const drops = page.sent
      .filter((each) => each.method === "Input.dispatchDragEvent")
      .map((each) => each.params.type);
    expect(drops).toEqual(["dragEnter", "dragOver", "drop"]);
    expect(page.sent.at(-1)?.params).not.toHaveProperty("files");
  });

  it("drag needs both ends", async () => {
    expect((await refused("drag", { from: "#a" })).code).toBe(
      "browser_bad_argument",
    );
  });
});

describe("type, fill, select, press", () => {
  it("type clicks the field, inserts text, and reports a count, never the text", async () => {
    const text = await run("type", {
      role: "textbox",
      name: "邮箱",
      text: "秘密内容",
      replace: true,
    });
    expect(text).toContain("输入 4 个字符");
    expect(text).not.toContain("秘密内容");
    const methods = page.methods();
    expect(methods).toContain("Input.insertText");
    expect(
      page.sent
        .filter((each) => each.method === "Input.dispatchKeyEvent")
        .map((each) => each.params.commands),
    ).toEqual([["selectAll"], ["deleteBackward"]]);
  });

  it("type without a target goes to the focused field, and refuses when there is none", async () => {
    page.scripts.activeField = { found: true, editable: true };
    expect(await run("type", { text: "ab" })).toContain("已输入 2 个字符");
    page.scripts.activeField = { found: false };
    expect((await refused("type", { text: "ab" })).message).toContain(
      "当前焦点不在输入框上",
    );
    expect(
      (await refused("type", { role: "button", name: "提交", text: "x" }))
        .message,
    ).toContain("不是能输入文字的地方");
  });

  it("fill does text, checkbox and dropdown in one call", async () => {
    const snap = await run("read");
    const box = page.element(14)!;
    page.after = (sent) => {
      if (sent.params.type === "mouseReleased" && sent.params.y === 430)
        box.state = { ...box.state, checked: true };
    };
    const text = await run("fill", {
      fields: [
        `${refIn(snap, '"邮箱"')}=x@y.z`,
        `${refIn(snap, '"同意"')}=true`,
        `${refIn(snap, '"地区"')}=上海`,
      ],
    });
    expect(text).toContain("已填写 3 项");
    expect(text).toContain("已输入 5 个字符");
    expect(text).toContain("已勾选");
    expect(text).toContain("选了 上海");
  });

  it("fill says what was already filled when a later field fails", async () => {
    const snap = await run("read");
    const failed = await refused("fill", {
      fields: [`${refIn(snap, '"邮箱"')}=x`, "e999=1"],
    });
    expect(failed.message).toContain("已填：");
    expect((await refused("fill", { fields: ["no-equals"] })).code).toBe(
      "browser_bad_argument",
    );
    expect(
      (await refused("fill", { fields: [`${refIn(snap, '"同意"')}=maybe`] }))
        .message,
    ).toContain("true 或 false");
  });

  it("select types ahead first, and falls back to the one writer for a native dropdown", async () => {
    const text = await run("select", {
      role: "combobox",
      name: "地区",
      labels: ["上海"],
    });
    expect(text).toContain("已选中：上海");
    const chars = page.sent
      .filter((each) => each.params.type === "char")
      .map((each) => each.params.text);
    expect(chars).toEqual(["上", "海"]);
    expect(page.methods()).toContain("DOM.focus");
    expect(
      (
        await refused("select", {
          role: "combobox",
          name: "地区",
          labels: ["广州"],
        })
      ).code,
    ).toBe("browser_not_found");
    expect(
      (
        await refused("select", {
          role: "checkbox",
          name: "同意",
          labels: ["x"],
        })
      ).message,
    ).toContain("不是下拉框");
  });

  it("select picks several options of a multiple select, and only of one", async () => {
    page.elements.push(
      el(80, "listbox", "标签", {
        box: { x: 400, y: 100, w: 80, h: 60 },
        options: ["甲", "乙", "丙"],
        state: {
          tag: "select",
          isSelect: true,
          multiple: true,
          options: [
            { value: "a", label: "甲", selected: true },
            { value: "b", label: "乙", selected: false },
            { value: "c", label: "丙", selected: false },
          ],
        },
      }),
    );
    const text = await run("select", {
      role: "listbox",
      name: "标签",
      values: ["c"],
      labels: ["乙", "丙"],
    });
    expect(text).toContain("已选中：乙、丙");
    // Straight to the writer, with both indexes; no type-ahead, which would
    // replace the selection with one option.
    const call = page.sent.find(
      (each) =>
        each.method === "Runtime.callFunctionOn" &&
        (each.params.arguments as Array<{ value: unknown }> | undefined)?.[0]
          ?.value === "1,2",
    );
    expect(call).toBeDefined();
    expect(page.sent.some((each) => each.params.type === "char")).toBe(false);
    expect(page.element(80)!.state!.options).toEqual([
      { value: "甲", label: "甲", selected: false },
      { value: "乙", label: "乙", selected: true },
      { value: "丙", label: "丙", selected: true },
    ]);
    // Several for a select without `multiple`: refused, nothing written.
    const before = page.sent.length;
    const single = await refused("select", {
      role: "combobox",
      name: "地区",
      values: ["bj", "sh"],
    });
    expect(single.code).toBe("browser_refused");
    expect(single.message).toContain("multiple");
    expect(
      page.sent
        .slice(before)
        .some(
          (each) =>
            each.method === "Runtime.callFunctionOn" &&
            each.params.arguments !== undefined,
        ),
    ).toBe(false);
    // The same option named by value and by text is one option.
    expect(
      await run("select", {
        role: "combobox",
        name: "地区",
        values: ["sh"],
        labels: ["上海"],
      }),
    ).toContain("已选中：上海");
    expect(
      (
        await refused("select", {
          role: "listbox",
          name: "标签",
          labels: ["甲", "丁"],
        })
      ).code,
    ).toBe("browser_not_found");
  });

  it("select opens a custom combobox and clicks the option", async () => {
    page.elements.push(
      el(70, "combobox", "水果", {
        value: "苹果",
        box: { x: 300, y: 40, w: 80, h: 20 },
      }),
    );
    page.after = (sent) => {
      if (sent.params.type === "mouseReleased" && !page.element(71))
        page.elements.push(
          el(71, "option", "苹果", { box: { x: 300, y: 60, w: 80, h: 20 } }),
          el(72, "option", "香蕉", { box: { x: 300, y: 80, w: 80, h: 20 } }),
        );
    };
    expect(
      await run("select", { role: "combobox", name: "水果", labels: ["香蕉"] }),
    ).toContain("已选中：香蕉");
  });

  it("press takes named keys and chords, and refuses typing and clipboard chords", async () => {
    expect(await run("press", { key: "Enter", repeat: 2 })).toContain(
      "已按下 Enter 2 次",
    );
    expect(await run("press", { key: "Control+Shift+z" })).toContain("已按下");
    expect(await run("press", { key: "F5" })).toContain("已按下");
    const chord = page.sent.find((each) => each.params.key === "z");
    expect(chord?.params.modifiers).toBe(10);
    expect((await refused("press", { key: "a" })).message).toContain(
      "请用 type",
    );
    expect((await refused("press", { key: "Meta+v" })).message).toContain(
      "不能按",
    );
    expect((await refused("press", { key: "Hyper+a" })).code).toBe(
      "browser_bad_argument",
    );
  });
});

/* -------------------------------- scrolling -------------------------------- */

describe("scroll", () => {
  it("reports the measured move, and scrolls sideways for left and right", async () => {
    page.scripts.scrollPosition = [
      {
        top: 0,
        left: 0,
        height: 2_000,
        width: 800,
        viewportHeight: 600,
        viewportWidth: 800,
      },
      {
        top: 0,
        left: 300,
        height: 2_000,
        width: 1_600,
        viewportHeight: 600,
        viewportWidth: 800,
      },
    ];
    const text = await run("scroll", { direction: "right", amount: 300 });
    expect(text).toContain("已滚动 0 px，横向 300 px");
    const wheel = page.sent.find((each) => each.params.type === "mouseWheel");
    expect(wheel?.params).toMatchObject({ deltaX: 300, deltaY: 0 });
  });

  it("brings an element into view with --ref", async () => {
    const ref = refIn(await run("read"), '"提交"');
    expect(await run("scroll", { ref })).toContain("滚进可视区域");
    expect(page.methods()).toContain("DOM.scrollIntoViewIfNeeded");
  });

  it("refuses a direction that is not one", async () => {
    expect((await refused("scroll", { direction: "sideways" })).code).toBe(
      "browser_bad_argument",
    );
  });
});

/* --------------------------------- waiting --------------------------------- */

describe("wait", () => {
  it("waits for text to appear and to go away, across iframes", async () => {
    page.scripts.hasText = [{ found: false }, { found: true }];
    expect(await run("wait", { text: "完成", timeoutMs: 2_000 })).toContain(
      "内满足",
    );
    page.scripts.hasText = { found: false };
    expect(
      await run("wait", { textGone: "加载中", timeoutMs: 2_000 }),
    ).toContain("内满足");
    page.scripts.hasText = { found: true };
    expect(await run("wait", { textGone: "加载中", timeoutMs: 150 })).toContain(
      "等待超时",
    );
  });

  it("waits for the network to go idle, and says what is still open", async () => {
    session.noteEvent("Network.requestWillBeSent", {
      requestId: "1",
      timestamp: 1,
      request: { url: "https://x.test/" },
    });
    const busy = await run("wait", { idle: true, timeoutMs: 150 });
    expect(busy).toContain("仍有 1 个请求未完成");
    session.noteEvent("Network.loadingFinished", {
      requestId: "1",
      timestamp: 2,
    });
    await new Promise((done) => setTimeout(done, 550));
    expect(await run("wait", { idle: true, timeoutMs: 1_000 })).toContain(
      "内满足",
    );
  });

  it("needs a condition", async () => {
    expect((await refused("wait")).code).toBe("browser_bad_argument");
  });
});

/* --------------------------------- files ----------------------------------- */

describe("capture and pdf", () => {
  it("captures the viewport, the full page beyond it, and one element", async () => {
    // 回答里是落盘后的绝对路径，按本机分隔符写。
    expect(await run("capture", { path: "s/view.png" })).toContain(
      join("s", "view.png"),
    );
    await run("capture", { path: "s/full.png", fullPage: true });
    const full = page.sent
      .filter((each) => each.method === "Page.captureScreenshot")
      .at(-1)!;
    expect(full.params).toMatchObject({
      captureBeyondViewport: true,
      clip: { width: 800, height: 2_000 },
    });
    page.scroll.y = 100;
    const element = await run("capture", {
      path: "s/el.png",
      role: "button",
      name: "提交",
    });
    expect(element).toContain('button "提交"');
    const clip = page.sent
      .filter((each) => each.method === "Page.captureScreenshot")
      .at(-1)!.params.clip;
    expect(clip).toMatchObject({ x: 10, y: 430, width: 100, height: 20 });
  });

  it("writes only inside the workspace", async () => {
    expect((await refused("capture", { path: "../out.png" })).code).toBe(
      "browser_refused",
    );
    expect((await refused("capture", { path: "escape/x.png" })).code).toBe(
      "browser_refused",
    );
  });

  it("prints a PDF through CDP, or through the host that prints its own way", async () => {
    const text = await run("pdf", { path: "p.pdf", landscape: true });
    expect(text).toMatch(/PDF 已保存到工作区：.*p\.pdf\n1 页/);
    expect(
      readFileSync(join(workspace, "p.pdf")).subarray(0, 5).toString(),
    ).toBe("%PDF-");
    expect(
      page.sent.find((each) => each.method === "Page.printToPDF")?.params,
    ).toMatchObject({ landscape: true });
    page.sent.length = 0;
    await run(
      "pdf",
      { path: "q.pdf" },
      {
        printToPdf: async () => {
          printed += 1;
          return Buffer.from("%PDF-1.7 /Type /Page ");
        },
      },
    );
    expect(printed).toBe(1);
    expect(page.methods()).not.toContain("Page.printToPDF");
    // Electron's printer hangs on a page with a cross-origin iframe: refused
    // before it is asked.
    page.children.set("child-1", {
      targetId: "F",
      owner: 1,
      url: "https://x.test/",
    });
    session.noteEvent("Target.attachedToTarget", {
      sessionId: "child-1",
      targetInfo: { type: "iframe", targetId: "F", url: "https://x.test/" },
    });
    await expect(
      runVerbOnHost(
        host({ printToPdf: async () => Buffer.from("%PDF-") }),
        "pdf",
        { workspaceRoot: workspace, path: "r.pdf" },
      ),
    ).rejects.toThrow("跨源 iframe");
  });
});

describe("upload", () => {
  it("answers a chooser the page opened with workspace files, by name only", async () => {
    chooser = { backendNodeId: 99 };
    const text = await run("upload", { paths: ["a.txt"] });
    expect(text).toContain("回填页面打开的文件选择框：a.txt");
    expect(text).not.toContain(workspace);
  });

  it("refuses the whole batch when one file is outside", async () => {
    chooser = { backendNodeId: 99 };
    expect(
      (await refused("upload", { paths: ["a.txt", "../secret"] })).code,
    ).toBe("browser_refused");
    expect(page.methods()).not.toContain("DOM.setFileInputFiles");
  });
});

/* ------------------------------ page and tabs ------------------------------ */

describe("navigate, history, resize, tabs", () => {
  it("navigates http(s) only, and stops loading with --action stop", async () => {
    expect(
      await run("navigate", { url: "https://example.test/b", action: "goto" }),
    ).toContain("已导航");
    expect(
      (await refused("navigate", { url: "file:///etc/passwd", action: "goto" }))
        .code,
    ).toBe("browser_refused");
    expect(await run("navigate", { action: "stop" })).toContain("已停止加载");
    expect(page.methods()).toContain("Page.stopLoading");
    expect((await refused("navigate", { action: "jump" })).code).toBe(
      "browser_bad_argument",
    );
  });

  it("walks the history entries", async () => {
    await run("back");
    expect(
      page.sent.find((each) => each.method === "Page.navigateToHistoryEntry")
        ?.params,
    ).toEqual({ entryId: 10 });
    page.history.currentIndex = 2;
    expect((await refused("forward")).code).toBe("browser_refused");
  });

  it("resizes through the host when it owns the viewport, else by emulation", async () => {
    await run(
      "resize",
      { width: 800, height: 600 },
      { resize: async (size) => void resized.push(size) },
    );
    expect(resized).toEqual([{ width: 800, height: 600 }]);
    await run("resize", { width: 1_024, height: 700 });
    expect(
      page.sent.find(
        (each) => each.method === "Emulation.setDeviceMetricsOverride",
      )?.params,
    ).toEqual({
      width: 1_024,
      height: 700,
      deviceScaleFactor: 0,
      mobile: false,
    });
    await run("resize", { reset: true });
    expect(page.methods()).toContain("Emulation.clearDeviceMetricsOverride");
    expect((await refused("resize", { width: 10, height: 10 })).code).toBe(
      "browser_bad_argument",
    );
  });

  it("lists, switches and closes tabs, never the last one", async () => {
    expect(await run("tabs")).toContain("* t1");
    await run("tabs", { switch: "t2" });
    expect(requested).toEqual([{ action: "switch", tabId: "t2", url: "" }]);
    expect((await refused("tabs", { switch: "t9" })).code).toBe(
      "browser_not_found",
    );
    await run("close", { tab: "t2" });
    expect(requested.at(-1)).toEqual({ action: "close", tabId: "t2", url: "" });
  });
});

/* -------------------------------- dialogs ---------------------------------- */

describe("dialogs", () => {
  it("refuse other verbs with the dialog's text until it is answered", async () => {
    dialog = {
      id: "d1",
      kind: "confirm",
      message: "确定删除？",
      defaultPrompt: "",
    };
    const blocked = await refused("click", { role: "button", name: "提交" });
    expect(blocked.code).toBe("browser_dialog_pending");
    expect(blocked.message).toContain("确定删除？");
    expect(await run("read", { mode: "console" })).toContain("控制台");
    expect(await run("dialog", { accept: true })).toContain(
      "已确定对话框（confirm）",
    );
    expect(dialog).toBeUndefined();
  });

  it("a click that opens a dialog returns instead of waiting behind it", async () => {
    let release: () => void = () => {};
    const inner = page.dispatch;
    session = new CdpSession(async (method, params, frame) => {
      if (params.type === "mouseReleased") {
        session.noteEvent("Page.javascriptDialogOpening", {
          type: "alert",
          message: "嗨",
        });
        return new Promise((done) => {
          release = () => done({});
        });
      }
      return inner(method, params, frame);
    });
    await session.refreshViewport();
    const text = await run("click", { role: "button", name: "提交" });
    expect(text).toContain("页面弹出了对话框");
    expect((await refused("read")).code).toBe("browser_dialog_pending");
    release();
  });
});

describe("the trace", () => {
  it("never carries page-side evaluation, a Debugger method or an expression", async () => {
    const snap = await run("read");
    for (const [verb, args] of [
      ["click", { ref: refIn(snap, '"提交"') }],
      ["hover", { role: "button", name: "提交" }],
      ["type", { role: "textbox", name: "邮箱", text: "x" }],
      ["select", { role: "combobox", name: "地区", labels: ["上海"] }],
      ["press", { key: "Tab" }],
      ["scroll", { direction: "down" }],
      ["capture", { path: "c.png" }],
      ["pdf", { path: "c.pdf" }],
    ] as const) {
      await run(verb, args as Record<string, unknown>);
    }
    for (const each of page.sent) {
      expect(each.method).not.toMatch(
        /^Runtime\.(evaluate|compileScript|runScript)$/,
      );
      expect(each.method.startsWith("Debugger.")).toBe(false);
      expect(Object.keys(each.params)).not.toContain("expression");
    }
  });
});
