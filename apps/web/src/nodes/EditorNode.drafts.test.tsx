/**
 * 编辑器的草稿保护与 Git 行边标记（编辑器设计 §2、§3）：未保存的内容落到
 * 本机、重开时放回；磁盘在草稿期间变了走三方合并；文件没了可以另存为；
 * 行边标记从 `git/diff` 倒推 HEAD，跟着编辑实时变。
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

import { installDomPolyfills } from "@/app/test-harness";
import { usePreferencesStore } from "../app/preferences-store";

installDomPolyfills();

const mocks = vi.hoisted(() => ({
  info: vi.fn(),
  read: vi.fn(),
  write: vi.fn(),
  version: vi.fn(),
  diff: vi.fn(),
  updateNodeData: vi.fn(),
  updateNode: vi.fn(),
}));
vi.mock("@/api/client", () => ({
  isConflict: () => false,
  runtimeApi: {
    settings: () => Promise.resolve({}),
    fileInfo: mocks.info,
    readFile: mocks.read,
    writeFile: mocks.write,
    watchFile: async () => ({
      status: "watching",
      version: await mocks.version(),
    }),
    unwatchFile: async () => undefined,
    fileVersion: mocks.version,
    gitDiff: mocks.diff,
  },
}));
vi.mock("@/store/canvas-store", () => {
  const useCanvasStore = (select: (state: unknown) => unknown) =>
    select({ workspace: { id: "w1" }, selectedNodeIds: [] });
  useCanvasStore.getState = () => ({
    updateNodeData: mocks.updateNodeData,
    updateNode: mocks.updateNode,
  });
  return { useCanvasStore };
});
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

import { MergeDialog } from "@/editor/merge/MergeDialog";
import { useMergeStore } from "@/editor/merge/merge-store";
import { EditorNode } from "./EditorNode";
import { ORIGIN_MAX_CHARS, readDraft, writeDraft } from "./editor/drafts";

const ON_DISK = "a".repeat(64);
const OLD = "b".repeat(64);
const SAVED = "c".repeat(64);

const props = (path = "note.txt") => ({
  id: "editor-1",
  selected: false,
  collapsed: false,
  focused: false,
  node: { title: path, data: { kind: "editor", path } } as never,
});

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
  for (const mock of Object.values(mocks)) mock.mockReset();
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  });
  usePreferencesStore.setState({ locale: "en" });
  mocks.info.mockResolvedValue({ preview: "text" });
  mocks.read.mockResolvedValue({
    content: "a\nb\nc\n",
    size: 6,
    sha256: ON_DISK,
  });
  mocks.version.mockResolvedValue({
    path: "note.txt",
    exists: true,
    sha256: ON_DISK,
  });
  mocks.diff.mockResolvedValue({ repository: false, clean: true, files: [] });
});
afterEach(() => {
  cleanup();
  useMergeStore.getState().close();
  vi.unstubAllGlobals();
});

describe("editor drafts", () => {
  it("keeps an unsaved draft on this device and puts it back on reopen", async () => {
    const first = render(<EditorNode {...props()} />);
    replace(await view(), "a\nmine\nc\n");
    // 卸载时排着队的那次写入立刻落下去。
    first.unmount();
    expect(readDraft("w1", "note.txt")).toMatchObject({
      baseVersion: ON_DISK,
      base: "a\nb\nc\n",
      draft: "a\nmine\nc\n",
    });

    render(<EditorNode {...props()} />);
    const editor = await view();
    await waitFor(() =>
      expect(editor.state.doc.toString()).toBe("a\nmine\nc\n"),
    );
    expect(screen.getByLabelText("Unsaved")).toBeTruthy();
    // 磁盘没变：不挂提示条。
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("forgets the draft once it is saved", async () => {
    mocks.write.mockResolvedValue({ size: 9, sha256: SAVED });
    render(<EditorNode {...props()} />);
    const editor = await view();
    replace(editor, "a\nmine\nc\n");
    fireEvent.click(screen.getByRole("button", { name: /save/i }));
    await waitFor(() => expect(mocks.write).toHaveBeenCalled());
    await waitFor(() => expect(readDraft("w1", "note.txt")).toBeNull());
  });

  it("merges a draft with a disk version that changed meanwhile", async () => {
    // 两边改的是不相邻的两行，合并不需要人挑。
    writeDraft("w1", "note.txt", {
      baseVersion: OLD,
      base: "a\nb\nc\nd\ne\n",
      draft: "a\nB\nc\nd\ne\n",
    });
    mocks.read.mockResolvedValue({
      content: "a\nb\nc\nd\nE\n",
      size: 10,
      sha256: ON_DISK,
    });
    mocks.write.mockResolvedValue({ size: 6, sha256: SAVED });
    render(
      <>
        <EditorNode {...props()} />
        <MergeDialog />
      </>,
    );
    const editor = await view();
    // 草稿放回来了，但磁盘那一版没被悄悄盖掉：提示条给出合并。
    await waitFor(() =>
      expect(editor.state.doc.toString()).toBe("a\nB\nc\nd\ne\n"),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Merge" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Apply to draft" }),
    );
    await waitFor(() =>
      expect(editor.state.doc.toString()).toBe("a\nB\nc\nd\nE\n"),
    );
    expect(screen.queryByRole("status")).toBeNull();

    // 合并结果带着磁盘那一版的内容版本保存。
    fireEvent.click(screen.getByRole("button", { name: /save/i }));
    await waitFor(() =>
      expect(mocks.write).toHaveBeenCalledWith(
        "w1",
        "note.txt",
        "a\nB\nc\nd\nE\n",
        10,
        ON_DISK,
        false,
      ),
    );
  });

  it("opens the draft of a file that is gone and saves it elsewhere", async () => {
    writeDraft("w1", "note.txt", {
      baseVersion: OLD,
      base: "a\n",
      draft: "kept\n",
    });
    mocks.info.mockRejectedValue(new Error("Requested path does not exist"));
    mocks.version.mockResolvedValue({ path: "note.txt", exists: false });
    mocks.write.mockResolvedValue({ size: 5, sha256: SAVED });
    render(<EditorNode {...props()} />);
    const editor = await view();
    expect(editor.state.doc.toString()).toBe("kept\n");
    expect(
      await screen.findByText("The file was deleted on disk"),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Save as" }));
    fireEvent.change(await screen.findByLabelText("Path in the workspace"), {
      target: { value: "moved/note.txt" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(mocks.write).toHaveBeenCalledWith(
        "w1",
        "moved/note.txt",
        "kept\n",
        undefined,
        undefined,
        false,
      ),
    );
    await waitFor(() =>
      expect(mocks.updateNodeData).toHaveBeenCalledWith("editor-1", {
        path: "moved/note.txt",
      }),
    );
    expect(mocks.updateNode).toHaveBeenCalledWith("editor-1", {
      title: "note.txt",
    });
    expect(readDraft("w1", "note.txt")).toBeNull();
  });
});

describe("relocating a draft whose file is gone", () => {
  /** 文件没了，草稿放在编辑器里；`other.txt` 是目标。 */
  function orphan(draft: { base: string; draft: string }, other: unknown) {
    writeDraft("w1", "note.txt", { baseVersion: OLD, ...draft });
    mocks.info.mockRejectedValue(new Error("Requested path does not exist"));
    mocks.version.mockResolvedValue({ path: "note.txt", exists: false });
    mocks.read.mockImplementation(async (_workspace: string, path: string) => {
      if (path !== "other.txt") throw new Error("gone");
      if (other instanceof Error) throw other;
      return other;
    });
  }

  async function relocateTo(path: string) {
    await screen.findByText("The file was deleted on disk");
    fireEvent.click(screen.getByRole("button", { name: "Relocate" }));
    fireEvent.change(await screen.findByLabelText("Path in the workspace"), {
      target: { value: path },
    });
  }

  it("merges the draft into an existing file and carries the result over", async () => {
    orphan(
      { base: "a\nb\nc\nd\ne\n", draft: "a\nB\nc\nd\ne\n" },
      { content: "a\nb\nc\nd\nE\n", size: 10, sha256: ON_DISK },
    );
    render(
      <>
        <EditorNode {...props()} />
        <MergeDialog />
      </>,
    );
    await view();
    await relocateTo("other.txt");
    fireEvent.click(screen.getByRole("button", { name: "Merge" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Apply to draft" }),
    );
    await waitFor(() =>
      expect(mocks.updateNodeData).toHaveBeenCalledWith("editor-1", {
        path: "other.txt",
      }),
    );
    // 合并结果成了目标文件的草稿，按它的内容版本放回；旧路径的草稿清掉。
    expect(readDraft("w1", "other.txt")).toMatchObject({
      base: "a\nb\nc\nd\nE\n",
      draft: "a\nB\nc\nd\nE\n",
      baseVersion: ON_DISK,
    });
    expect(readDraft("w1", "note.txt")).toBeNull();
    // 合并不写盘。
    expect(mocks.write).not.toHaveBeenCalled();
  });

  it("keeps the real base across edits after the file is gone, so the merge only conflicts where both sides did", async () => {
    orphan(
      { base: "a\nb\nc\nd\ne\n", draft: "a\nB\nc\nd\ne\n" },
      { content: "a\nb\nc\nd\nE\n", size: 10, sha256: ON_DISK },
    );
    const first = render(<EditorNode {...props()} />);
    // 文件没了之后又改了一处：本机副本改写了，base 成了空串，但草稿改起时
    // 的那一版与它的内容版本跟着带下去。
    replace(await view(), "A\nB\nc\nd\ne\n");
    first.unmount();
    expect(readDraft("w1", "note.txt")).toMatchObject({
      base: "",
      draft: "A\nB\nc\nd\ne\n",
      origin: "a\nb\nc\nd\ne\n",
      originVersion: OLD,
    });

    // 再打开一次（base 仍是空串）、再改一次，那一版还在。
    render(
      <>
        <EditorNode {...props()} />
        <MergeDialog />
      </>,
    );
    const editor = await view();
    await waitFor(() =>
      expect(editor.state.doc.toString()).toBe("A\nB\nc\nd\ne\n"),
    );
    replace(editor, "A\nB\nc\nd\ne\n\n");
    replace(editor, "A\nB\nc\nd\ne\n");
    await relocateTo("other.txt");
    fireEvent.click(screen.getByRole("button", { name: "Merge" }));
    // 两边改的是不相邻的行：没有冲突要人挑，直接应用。
    fireEvent.click(
      await screen.findByRole("button", { name: "Apply to draft" }),
    );
    await waitFor(() =>
      expect(readDraft("w1", "other.txt")).toMatchObject({
        base: "a\nb\nc\nd\nE\n",
        draft: "A\nB\nc\nd\nE\n",
        baseVersion: ON_DISK,
      }),
    );
  });

  it("does not keep a second copy of a very large base", async () => {
    const big = "x".repeat(ORIGIN_MAX_CHARS + 1);
    orphan({ base: big, draft: "kept\n" }, new Error("unused"));
    const first = render(<EditorNode {...props()} />);
    replace(await view(), "kept more\n");
    first.unmount();
    const stored = readDraft("w1", "note.txt");
    expect(stored).toMatchObject({ base: "", draft: "kept more\n" });
    expect(stored?.origin).toBeUndefined();
  });

  it("overwrites an existing file only after a confirmation", async () => {
    orphan(
      { base: "a\n", draft: "kept\n" },
      { content: "old\n", size: 4, sha256: ON_DISK },
    );
    mocks.write.mockResolvedValue({ size: 5, sha256: SAVED });
    render(<EditorNode {...props()} />);
    await view();
    await relocateTo("other.txt");
    fireEvent.click(screen.getByRole("button", { name: "Overwrite" }));
    expect(mocks.write).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole("button", { name: "Overwrite" }));
    await waitFor(() =>
      expect(mocks.write).toHaveBeenCalledWith(
        "w1",
        "other.txt",
        "kept\n",
        4,
        ON_DISK,
        false,
      ),
    );
    await waitFor(() =>
      expect(mocks.updateNodeData).toHaveBeenCalledWith("editor-1", {
        path: "other.txt",
      }),
    );
    expect(mocks.updateNode).toHaveBeenCalledWith("editor-1", {
      title: "other.txt",
    });
    expect(readDraft("w1", "note.txt")).toBeNull();
  });

  it("says so when there is no file at the chosen path", async () => {
    orphan(
      { base: "a\n", draft: "kept\n" },
      Object.assign(new Error("Requested path does not exist"), {
        status: 404,
      }),
    );
    render(<EditorNode {...props()} />);
    await view();
    await relocateTo("other.txt");
    fireEvent.click(screen.getByRole("button", { name: "Merge" }));
    expect(await screen.findByText("No file at this path")).toBeTruthy();
    expect(mocks.updateNodeData).not.toHaveBeenCalled();
    expect(readDraft("w1", "note.txt")).not.toBeNull();
  });
});

describe("git gutter", () => {
  it("marks lines against HEAD and follows the edits", async () => {
    mocks.diff.mockImplementation(
      async (_workspace: string, options: { scope: string }) =>
        options.scope === "worktree"
          ? {
              repository: true,
              clean: false,
              files: [
                {
                  path: "note.txt",
                  status: "M",
                  additions: 1,
                  deletions: 1,
                  patch: "@@ -2 +2 @@\n-was\n+b",
                  previewable: true,
                  staged: false,
                },
              ],
            }
          : { repository: true, clean: true, files: [] },
    );
    render(<EditorNode {...props()} />);
    const editor = await view();
    await waitFor(() =>
      expect(document.querySelectorAll(".cm-git-modified")).toHaveLength(1),
    );
    expect(document.querySelectorAll(".cm-git-added")).toHaveLength(0);
    expect(mocks.diff).toHaveBeenCalledWith("w1", {
      scope: "staged",
      paths: ["note.txt"],
    });

    replace(editor, "a\nb\nc\nnew\n");
    await waitFor(() =>
      expect(document.querySelectorAll(".cm-git-added")).toHaveLength(1),
    );
  });
});
