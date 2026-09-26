/**
 * 编辑器的外部改动检测、比较与重载（E01/M4）。
 *
 * 事件走真实的 `dispatchWorkspaceEvent`，只把 Runtime 客户端换成假的：
 * 这样解析、订阅和节点的三种选择都在同一条路径上被覆盖。
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

const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  write: vi.fn(),
  watch: vi.fn(),
  unwatch: vi.fn(),
  version: vi.fn(),
}));
vi.mock("@/api/client", () => ({
  isConflict: () => true,
  runtimeApi: {
    // 编辑器挂载时读一次 `language.formatOnSave`（语言服务设计 §2.3）。
    settings: () => Promise.resolve({}),
    fileInfo: async () => ({ preview: "text" }),
    readFile: mocks.read,
    writeFile: mocks.write,
    watchFile: mocks.watch,
    unwatchFile: mocks.unwatch,
    fileVersion: mocks.version,
  },
}));
vi.mock("@/store/canvas-store", () => ({
  useCanvasStore: (select: (state: unknown) => unknown) =>
    select({ workspace: { id: "w1" }, selectedNodeIds: [] }),
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

import { dispatchWorkspaceEvent, resetWorkspaceEvents } from "@/api/events";
import { EditorNode } from "./EditorNode";

const ON_DISK = "a".repeat(64);
const CHANGED = "b".repeat(64);
const SAVED = "c".repeat(64);

const props = (path = "note.txt") => ({
  id: "editor-1",
  selected: false,
  collapsed: false,
  focused: false,
  node: { title: path, data: { kind: "editor", path } } as never,
});

function changed(sha256: string | null, kind = "modified") {
  return {
    type: "file.changed" as const,
    workspaceId: "w1",
    path: "note.txt",
    kind: kind as "modified" | "removed" | "replaced",
    sha256,
    size: sha256 === null ? null : 4,
    mtime: null,
  };
}

async function view(): Promise<EditorView> {
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
  // 草稿按「工作空间 + 路径」存进 localStorage：上一条用例改了没存的正文，会在
  // 这一条打开同一个文件时被当作草稿放回来。每条都从空存储开始。
  localStorage.clear();
  for (const mock of Object.values(mocks)) mock.mockReset();
  usePreferencesStore.setState({ locale: "en" });
  mocks.read.mockResolvedValue({
    content: "one\n",
    size: 4,
    sha256: ON_DISK,
  });
  mocks.watch.mockResolvedValue({
    status: "watching",
    version: { path: "note.txt", exists: true, sha256: ON_DISK, size: 4 },
  });
  mocks.unwatch.mockResolvedValue(undefined);
  mocks.version.mockResolvedValue({
    path: "note.txt",
    exists: true,
    sha256: CHANGED,
    size: 4,
  });
});
afterEach(() => {
  cleanup();
  resetWorkspaceEvents();
});

describe("editor external changes", () => {
  it("registers the open file and releases it when the node goes away", async () => {
    const component = render(<EditorNode {...props()} />);
    await view();
    await waitFor(() =>
      expect(mocks.watch).toHaveBeenCalledWith("w1", "note.txt", "editor-1"),
    );
    component.unmount();
    expect(mocks.unwatch).toHaveBeenCalledWith("w1", "note.txt", "editor-1");
  });

  it("reloads a clean editor by itself and shows no prompt", async () => {
    render(<EditorNode {...props()} />);
    const editor = await view();
    await waitFor(() => expect(mocks.watch).toHaveBeenCalled());
    mocks.read.mockResolvedValue({
      content: "two\n",
      size: 4,
      sha256: CHANGED,
    });
    await act(async () => dispatchWorkspaceEvent(changed(CHANGED)));
    await waitFor(() => expect(editor.state.doc.toString()).toBe("two\n"));
    expect(screen.queryByRole("status")).toBeNull();
    expect(
      (screen.getByRole("button", { name: /save/i }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("never reports the editor's own save as an external change", async () => {
    mocks.write.mockResolvedValue({ size: 5, sha256: SAVED });
    render(<EditorNode {...props()} />);
    const editor = await view();
    await waitFor(() => expect(mocks.watch).toHaveBeenCalled());
    replace(editor, "mine\n");
    fireEvent.click(screen.getByRole("button", { name: /save/i }));
    await waitFor(() =>
      expect(mocks.write).toHaveBeenCalledWith(
        "w1",
        "note.txt",
        "mine\n",
        4,
        ON_DISK,
        false,
      ),
    );
    // A late event carrying the hash we just wrote is our own write coming
    // back, not somebody else's edit.
    await act(async () => dispatchWorkspaceEvent(changed(SAVED)));
    expect(screen.queryByRole("status")).toBeNull();
    expect(mocks.read).toHaveBeenCalledTimes(1);
  });

  it("compares the disk version against the draft without touching either", async () => {
    render(<EditorNode {...props()} />);
    const editor = await view();
    await waitFor(() => expect(mocks.watch).toHaveBeenCalled());
    replace(editor, "draft\n");
    await act(async () => dispatchWorkspaceEvent(changed(CHANGED)));
    expect(await screen.findByRole("status")).toBeTruthy();

    mocks.read.mockResolvedValue({
      content: "theirs\n",
      size: 7,
      sha256: CHANGED,
    });
    fireEvent.click(screen.getByRole("button", { name: "Compare" }));
    expect(await screen.findByText("-theirs")).toBeTruthy();
    expect(screen.getByText("+draft")).toBeTruthy();
    // Comparing changes neither the draft nor the save token.
    expect(editor.state.doc.toString()).toBe("draft\n");
    fireEvent.click(screen.getByRole("button", { name: "Close comparison" }));
    await waitFor(() => expect(screen.queryByText("-theirs")).toBeNull());
    expect(screen.getByRole("status")).toBeTruthy();
  });

  it("reloads and discards the draft when asked", async () => {
    render(<EditorNode {...props()} />);
    const editor = await view();
    await waitFor(() => expect(mocks.watch).toHaveBeenCalled());
    replace(editor, "draft\n");
    await act(async () => dispatchWorkspaceEvent(changed(CHANGED)));
    await screen.findByRole("status");

    mocks.read.mockResolvedValue({
      content: "theirs\n",
      size: 7,
      sha256: CHANGED,
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Reload and discard draft" }),
    );
    await waitFor(() => expect(editor.state.doc.toString()).toBe("theirs\n"));
    expect(screen.queryByRole("status")).toBeNull();
    expect(
      (screen.getByRole("button", { name: /save/i }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("keeps the draft and saves against the newest disk version", async () => {
    mocks.write.mockResolvedValue({ size: 6, sha256: SAVED });
    render(<EditorNode {...props()} />);
    const editor = await view();
    await waitFor(() => expect(mocks.watch).toHaveBeenCalled());
    replace(editor, "draft\n");
    await act(async () => dispatchWorkspaceEvent(changed(CHANGED)));
    await screen.findByRole("status");

    fireEvent.click(screen.getByRole("button", { name: "Keep draft" }));
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
    expect(editor.state.doc.toString()).toBe("draft\n");
    fireEvent.click(screen.getByRole("button", { name: /save/i }));
    await waitFor(() =>
      expect(mocks.write).toHaveBeenCalledWith(
        "w1",
        "note.txt",
        "draft\n",
        4,
        CHANGED,
        false,
      ),
    );
    // The draft is not re-read from disk: keeping it means keeping it.
    expect(mocks.read).toHaveBeenCalledTimes(1);
  });

  it("says the file is gone and keeps the draft saveable as a new file", async () => {
    mocks.write.mockResolvedValue({ size: 6, sha256: SAVED });
    render(<EditorNode {...props()} />);
    const editor = await view();
    await waitFor(() => expect(mocks.watch).toHaveBeenCalled());
    replace(editor, "draft\n");
    await act(async () => dispatchWorkspaceEvent(changed(null, "removed")));
    const bar = await screen.findByRole("status");
    expect(bar.textContent).toContain("deleted");
    // Nothing on disk to compare with or reload from.
    expect(screen.queryByRole("button", { name: "Compare" })).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Reload and discard draft" }),
    ).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Keep draft" }));
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: /save/i }));
    await waitFor(() =>
      expect(mocks.write).toHaveBeenCalledWith(
        "w1",
        "note.txt",
        "draft\n",
        4,
        undefined,
        false,
      ),
    );
  });

  it("falls back to on-demand version checks when watching is unsupported", async () => {
    mocks.watch.mockResolvedValue({
      status: "unsupported",
      reason: "no backend",
      version: { path: "note.txt", exists: true, sha256: ON_DISK, size: 4 },
    });
    render(<EditorNode {...props()} />);
    const editor = await view();
    expect(await screen.findByText("File watching unavailable")).toBeTruthy();
    replace(editor, "draft\n");
    expect(mocks.version).not.toHaveBeenCalled();

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await waitFor(() =>
      expect(mocks.version).toHaveBeenCalledWith("w1", "note.txt"),
    );
    expect(await screen.findByRole("status")).toBeTruthy();
  });

  it("says when a remote execution host polls instead of watching", async () => {
    mocks.watch.mockResolvedValue({
      status: "watching",
      mode: "poll",
      reason: "This execution host polls for changes every 2s",
      version: { path: "note.txt", exists: true, sha256: ON_DISK, size: 4 },
    });
    render(<EditorNode {...props()} />);
    await view();
    // A poll and a filesystem event are different promises about latency, and
    // the node says which one this file got rather than implying the faster.
    const badge = await screen.findByText("Polled");
    expect(badge.getAttribute("title")).toBe(
      "This execution host polls for changes every 2s",
    );
    expect(screen.queryByText("File watching unavailable")).toBeNull();
  });

  it("shows no delivery badge for an ordinary local watch", async () => {
    render(<EditorNode {...props()} />);
    await view();
    await waitFor(() => expect(mocks.watch).toHaveBeenCalled());
    expect(screen.queryByText("Polled")).toBeNull();
  });

  it("re-prompts when a save loses the version race", async () => {
    mocks.write.mockRejectedValue(new Error("conflict"));
    render(<EditorNode {...props()} />);
    const editor = await view();
    await waitFor(() => expect(mocks.watch).toHaveBeenCalled());
    replace(editor, "draft\n");
    fireEvent.click(screen.getByRole("button", { name: /save/i }));
    await waitFor(() => expect(mocks.version).toHaveBeenCalled());
    const bar = await screen.findByRole("status");
    expect(bar.textContent).toContain("changed on disk");
    expect(editor.state.doc.toString()).toBe("draft\n");
  });
});
