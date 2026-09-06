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
  isConflict: () => true,
  runtimeApi: {
    // 编辑器挂载时读一次 `language.formatOnSave`（语言服务设计 §2.3）。
    settings: () => Promise.resolve({}),
    fileInfo: async () => ({ preview: "text" }),
    readFile: mocks.read,
    writeFile: mocks.write,
    // 监听不在这一组用例的范围内：注册成功但永不推送。
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
const props = (path = "note.txt", readonly = false) => ({
  id: "editor",
  selected: false,
  collapsed: false,
  focused: false,
  node: { title: path, data: { kind: "editor", path, readonly } } as never,
});
const version = "a".repeat(64),
  savedVersion = "b".repeat(64);
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
function replace(editor: EditorView, content: string) {
  act(() =>
    editor.dispatch({
      changes: { from: 0, to: editor.state.doc.length, insert: content },
    }),
  );
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
  mocks.write.mockReset();
  usePreferencesStore.setState({ locale: "en" });
  mocks.read.mockResolvedValue({ content: "old", size: 3, sha256: version });
});
afterEach(cleanup);
describe("editor save versions", () => {
  it("keeps edits typed during a save dirty and sends the returned version next time", async () => {
    let finish!: (value: unknown) => void;
    mocks.write.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    render(<EditorNode {...props()} />);
    const editor = await view();
    replace(editor, "one");
    fireEvent.click(screen.getByRole("button", { name: /save/i }));
    expect(mocks.write).toHaveBeenCalledWith(
      "w1",
      "note.txt",
      "one",
      3,
      version,
      false,
    );
    replace(editor, "two");
    await act(async () => finish({ size: 3, sha256: savedVersion }));
    const save = screen.getByRole("button", { name: /save/i });
    expect((save as HTMLButtonElement).disabled).toBe(false);
    expect(editor.state.doc.toString()).toBe("two");
    mocks.write.mockResolvedValue({ size: 3, sha256: "c".repeat(64) });
    fireEvent.click(save);
    await waitFor(() =>
      expect(mocks.write).toHaveBeenLastCalledWith(
        "w1",
        "note.txt",
        "two",
        3,
        savedVersion,
        false,
      ),
    );
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: /save/i }) as HTMLButtonElement)
          .disabled,
      ).toBe(true),
    );
  });
  it("does not apply an old file's late save response to a newly opened file", async () => {
    let finish!: (value: unknown) => void;
    mocks.write.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const component = render(<EditorNode {...props()} />);
    replace(await view(), "one");
    fireEvent.click(screen.getByRole("button", { name: /save/i }));
    mocks.read.mockResolvedValue({
      content: "next",
      size: 4,
      sha256: "d".repeat(64),
    });
    component.rerender(<EditorNode {...props("next.txt")} />);
    await waitFor(() =>
      expect(document.querySelector(".cm-content")?.textContent).toBe("next"),
    );
    replace(await view(), "next draft");
    await act(async () => finish({ size: 3, sha256: savedVersion }));
    mocks.write.mockResolvedValue({ size: 10, sha256: "e".repeat(64) });
    fireEvent.click(screen.getByRole("button", { name: /save/i }));
    await waitFor(() =>
      expect(mocks.write).toHaveBeenLastCalledWith(
        "w1",
        "next.txt",
        "next draft",
        4,
        "d".repeat(64),
        false,
      ),
    );
  });
  it("preserves the draft when permissions change and recognizes returning to saved text", async () => {
    const component = render(<EditorNode {...props()} />);
    const editor = await view();
    replace(editor, "draft");
    component.rerender(<EditorNode {...props("note.txt", true)} />);
    await waitFor(() => expect(editor.state.readOnly).toBe(true));
    expect(editor.state.doc.toString()).toBe("draft");
    component.rerender(<EditorNode {...props()} />);
    await waitFor(() => expect(editor.state.readOnly).toBe(false));
    replace(editor, "old");
    expect(
      (screen.getByRole("button", { name: /save/i }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });
  it("leaves a server without content versions read-only", async () => {
    mocks.read.mockResolvedValue({ content: "old", size: 3 });
    render(<EditorNode {...props()} />);
    expect((await view()).state.readOnly).toBe(true);
    expect(screen.queryByRole("button", { name: /save/i })).toBeNull();
    expect(mocks.write).not.toHaveBeenCalled();
  });
});
