/**
 * 编辑器的文件信息与文本工作流（E01/M4）：编码 / BOM / 换行的状态栏、
 * 非 UTF-8 只读、CRLF 与 BOM 的原样保存、查找面板、Markdown 预览，
 * 以及项目搜索的「打开到行」。
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { EditorView } from "codemirror";

import { usePreferencesStore } from "../app/preferences-store";

const mocks = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn() }));
vi.mock("@/api/client", () => ({
  isConflict: () => false,
  runtimeApi: {
    fileInfo: async () => ({ preview: "text" }),
    readFile: mocks.read,
    writeFile: mocks.write,
    fileDownloadUrl: (workspaceId: string, path: string) =>
      `http://runtime/api/workspaces/${workspaceId}/file-download?path=${path}`,
    watchFile: async () => ({
      status: "watching",
      version: { path: "note.txt", exists: true },
    }),
    unwatchFile: async () => undefined,
    fileVersion: async () => ({ path: "note.txt", exists: true }),
  },
}));
vi.mock("@/store/canvas-store", () => ({
  useCanvasStore: (select: (state: unknown) => unknown) =>
    select({ workspace: { id: "w1" } }),
}));
vi.mock("./NodeShell", () => ({
  NodeShell: ({
    children,
    headerActions,
  }: {
    children: ReactNode;
    headerActions: ReactNode;
  }) => (
    <div>
      {headerActions}
      {children}
    </div>
  ),
}));

import { EditorNode } from "./EditorNode";
import { revealInEditor } from "./editor-reveal";

const VERSION = "a".repeat(64);

const props = (path = "note.txt") => ({
  id: "editor",
  selected: false,
  collapsed: false,
  focused: false,
  node: { title: path, data: { kind: "editor", path } } as never,
});

async function view() {
  let editor: EditorView | undefined;
  await waitFor(() => {
    const element = document.querySelector(".cm-editor");
    expect(element).toBeTruthy();
    editor = EditorView.findFromDOM(element as HTMLElement) ?? undefined;
    expect(editor).toBeTruthy();
  });
  return editor!;
}

const oldRects = Range.prototype.getClientRects;
const oldBounds = Range.prototype.getBoundingClientRect;
beforeAll(() => {
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
});
afterAll(() => {
  Range.prototype.getClientRects = oldRects;
  Range.prototype.getBoundingClientRect = oldBounds;
});

beforeEach(() => {
  mocks.read.mockReset();
  mocks.write
    .mockReset()
    .mockResolvedValue({ size: 4, sha256: "b".repeat(64) });
  usePreferencesStore.setState({ locale: "en" });
  mocks.read.mockResolvedValue({
    content: "one\n",
    size: 4,
    sha256: VERSION,
    encoding: "utf-8",
    bom: false,
    eol: "lf",
    readonly: false,
  });
});
afterEach(cleanup);

describe("editor file information", () => {
  it("shows the encoding and the line ending the runtime detected", async () => {
    render(<EditorNode {...props()} />);
    await view();
    expect(screen.getByText("UTF-8")).toBeTruthy();
    expect(screen.getByText("LF")).toBeTruthy();
    // 没有语言服务器就明说，不摆一个空补全入口。
    expect(screen.getByText("LSP not enabled")).toBeTruthy();
  });

  it("keeps CRLF through a save instead of silently normalizing the file", async () => {
    mocks.read.mockResolvedValue({
      content: "one\r\ntwo\r\n",
      size: 10,
      sha256: VERSION,
      encoding: "utf-8",
      bom: false,
      eol: "crlf",
      readonly: false,
    });
    render(<EditorNode {...props()} />);
    const editor = await view();
    expect(screen.getByText("CRLF")).toBeTruthy();
    // 声明了分隔符，`sliceDoc()` 拼回来的就是原来的 CRLF。
    expect(editor.state.sliceDoc()).toBe("one\r\ntwo\r\n");

    act(() =>
      editor.dispatch({
        changes: { from: editor.state.doc.length, insert: "three\r\n" },
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: /save/i }));
    await waitFor(() =>
      expect(mocks.write).toHaveBeenCalledWith(
        "w1",
        "note.txt",
        "one\r\ntwo\r\nthree\r\n",
        10,
        VERSION,
        false,
      ),
    );
  });

  it("writes a BOM back when the file arrived with one", async () => {
    mocks.read.mockResolvedValue({
      content: "one\n",
      size: 7,
      sha256: VERSION,
      encoding: "utf-8",
      bom: true,
      eol: "lf",
      readonly: false,
    });
    render(<EditorNode {...props()} />);
    const editor = await view();
    expect(screen.getByText("BOM")).toBeTruthy();
    act(() =>
      editor.dispatch({
        changes: { from: 0, to: editor.state.doc.length, insert: "two\n" },
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: /save/i }));
    await waitFor(() =>
      expect(mocks.write).toHaveBeenCalledWith(
        "w1",
        "note.txt",
        "two\n",
        7,
        VERSION,
        true,
      ),
    );
  });

  // 有损读出来的正文不能写回去：Runtime 不给内容版本，编辑器就没有保存钮。
  it("makes a file that is not UTF-8 read-only and says why", async () => {
    mocks.read.mockResolvedValue({
      content: "he�lo",
      size: 6,
      encoding: "unknown",
      bom: false,
      eol: "lf",
      readonly: false,
    });
    render(<EditorNode {...props()} />);
    await view();
    expect(screen.queryByRole("button", { name: /save/i })).toBeNull();
    expect(
      screen.getAllByText("A file that is not UTF-8 is read-only").length,
    ).toBeGreaterThan(0);
    expect(screen.getByText("Not UTF-8")).toBeTruthy();
  });

  it("opens the find panel with a replace row only when the file is writable", async () => {
    render(<EditorNode {...props()} />);
    await view();
    fireEvent.click(screen.getByRole("button", { name: "Find / replace" }));
    await waitFor(() =>
      expect(document.querySelector(".cm-search")).toBeTruthy(),
    );
    const panel = document.querySelector(".cm-search")!;
    // 正则 / 大小写 / 全字三个开关，加上替换那一半。
    expect(panel.querySelectorAll("input[type=checkbox]").length).toBe(3);
    expect(panel.querySelector('input[name="replace"]')).toBeTruthy();
  });

  it("hides the replace row for a read-only file", async () => {
    mocks.read.mockResolvedValue({
      content: "one\n",
      size: 4,
      encoding: "unknown",
      bom: false,
      eol: "lf",
      readonly: true,
    });
    render(<EditorNode {...props()} />);
    await view();
    fireEvent.click(screen.getByRole("button", { name: "Find / replace" }));
    await waitFor(() =>
      expect(document.querySelector(".cm-search")).toBeTruthy(),
    );
    expect(
      document.querySelector('.cm-search input[name="replace"]'),
    ).toBeNull();
  });

  it("previews Markdown without executing what the document contains", async () => {
    mocks.read.mockResolvedValue({
      content: "# Title\n\n<script>window.pwned = 1</script>\n\n![p](a.png)\n",
      size: 20,
      sha256: VERSION,
      encoding: "utf-8",
      bom: false,
      eol: "lf",
      readonly: false,
    });
    render(<EditorNode {...props("docs/readme.md")} />);
    await view();
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));

    const heading = await screen.findByText("Title");
    expect(heading.tagName).toBe("H1");
    // 裸 HTML 只以文本出现，页面上没有 script 元素。
    expect(document.querySelector(".sticky-markdown script")).toBeNull();
    // 相对路径的图片经 Runtime 的文件读取接口，且相对于文档所在目录。
    const image = document.querySelector(
      ".sticky-markdown img",
    ) as HTMLImageElement;
    expect(image.getAttribute("src")).toContain("path=docs/a.png");
  });

  it("jumps to the line a project-search match points at", async () => {
    mocks.read.mockResolvedValue({
      content: "one\ntwo\nthree\n",
      size: 14,
      sha256: VERSION,
      encoding: "utf-8",
      bom: false,
      eol: "lf",
      readonly: false,
    });
    render(<EditorNode {...props()} />);
    const editor = await view();
    act(() => revealInEditor("note.txt", 3));
    await waitFor(() =>
      expect(editor.state.selection.main.head).toBe(
        editor.state.doc.line(3).from,
      ),
    );
  });
});
