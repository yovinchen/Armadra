import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { LSPClient } from "@codemirror/lsp-client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ArmadraWorkspace } from "./documents";

vi.mock("@/files/open-editor", () => ({ openFileInEditor: vi.fn() }));

/**
 * 同一个文件、两个编辑器节点（语言服务设计 §2.5、§6.1 第 4 条）。
 *
 * 这些用例不连任何 socket：`LSPClient` 没有 transport 时 `notification`
 * 直接返回，所以这里断言的是 `Workspace` 自己的记账——谁是拥有者、
 * `syncFiles` 报谁的改动、拥有者走了之后所有权去哪。
 */

const URI = "armadra:///src/main.py";

const views: EditorView[] = [];

/**
 * 一个装了 LSP 插件的视图。用 `client.plugin()` 而不是手工
 * `workspace.openFile()`：插件在挂载时自己 `openFile`、销毁时 `closeFile`，
 * 而 `syncFiles` 读的正是插件累积的未同步改动——绕过它就测不到真实路径。
 */
function tracked(client: LSPClient, doc: string): EditorView {
  const created = new EditorView({
    state: EditorState.create({
      doc,
      extensions: [client.plugin(URI, "python")],
    }),
  });
  views.push(created);
  return created;
}

afterEach(() => {
  for (const created of views.splice(0)) created.destroy();
});

function workspace(): {
  workspace: ArmadraWorkspace;
  client: LSPClient;
  didOpen: ReturnType<typeof vi.fn>;
  didClose: ReturnType<typeof vi.fn>;
  notification: ReturnType<typeof vi.fn>;
} {
  const client = new LSPClient({
    workspace: (owner) => new ArmadraWorkspace(owner),
  });
  const didOpen = vi.fn();
  const didClose = vi.fn();
  const notification = vi.fn();
  client.didOpen = didOpen;
  client.didClose = didClose;
  client.notification = notification;
  return {
    workspace: client.workspace as ArmadraWorkspace,
    client,
    didOpen,
    didClose,
    notification,
  };
}

describe("one document, several editor nodes", () => {
  it("opens the document once and calls the second view a follower", () => {
    const { workspace: held, client, didOpen } = workspace();
    const first = tracked(client, "import os\n");
    const second = tracked(client, "import os\n");

    // 只有一次 didOpen：server 手里就该只有一份缓冲。
    expect(didOpen).toHaveBeenCalledTimes(1);
    expect(held.files).toHaveLength(1);
    expect(held.ownershipOf(first)).toBe("owner");
    expect(held.ownershipOf(second)).toBe("follower");
  });

  it("announces ownership to whoever is listening", () => {
    const { workspace: held, client } = workspace();
    const seen: [string, string][] = [];
    held.onOwnership((uri, _view, ownership) => seen.push([uri, ownership]));
    tracked(client, "x = 1\n");
    tracked(client, "x = 1\n");
    expect(seen).toEqual([
      [URI, "owner"],
      [URI, "follower"],
    ]);
  });

  it("reports only the owner's edits, and still clears the follower's", () => {
    const { workspace: held, client } = workspace();
    const first = tracked(client, "x = 1\n");
    const second = tracked(client, "x = 1\n");

    second.dispatch({ changes: { from: 0, insert: "# follower\n" } });
    // 跟随者改了，但它不是这份文档——一条也不该上报。
    expect(held.syncFiles()).toEqual([]);

    first.dispatch({ changes: { from: 0, insert: "# owner\n" } });
    const updates = held.syncFiles();
    expect(updates).toHaveLength(1);
    expect(updates[0]!.file.uri).toBe(URI);
    expect(updates[0]!.file.doc.toString()).toBe("# owner\nx = 1\n");
  });

  it("hands ownership to the earliest follower and resyncs its whole buffer", () => {
    const { workspace: held, client, didClose, notification } = workspace();
    const first = tracked(client, "x = 1\n");
    const second = tracked(client, "x = 1\n");
    const third = tracked(client, "x = 1\n");

    second.dispatch({ changes: { from: 0, insert: "y = 2\n" } });
    held.closeFile(URI, first);

    // 文档没关：还有别的节点开着它。
    expect(didClose).not.toHaveBeenCalled();
    expect(held.ownershipOf(second)).toBe("owner");
    expect(held.ownershipOf(third)).toBe("follower");
    // 新拥有者的增量是按它自己的缓冲算的，所以 server 先收一份全文。
    expect(notification).toHaveBeenCalledWith(
      "textDocument/didChange",
      expect.objectContaining({
        contentChanges: [{ text: "y = 2\nx = 1\n" }],
      }),
    );
    // 全文推过去之后，那次编辑不该再作为增量上报一次。
    expect(held.syncFiles()).toEqual([]);
  });

  it("closes the document only when the last view goes away", () => {
    const { workspace: held, client, didClose } = workspace();
    const first = tracked(client, "x = 1\n");
    const second = tracked(client, "x = 1\n");

    held.closeFile(URI, second);
    expect(didClose).not.toHaveBeenCalled();
    expect(held.ownershipOf(first)).toBe("owner");

    held.closeFile(URI, first);
    expect(didClose).toHaveBeenCalledWith(URI);
    expect(held.files).toEqual([]);
  });

  it("does not open a location outside the workspace", async () => {
    const { workspace: held } = workspace();
    const { openFileInEditor } = await import("@/files/open-editor");
    await expect(
      held.displayFile("armadra-external:///0f0f0f"),
    ).resolves.toBeNull();
    expect(openFileInEditor).not.toHaveBeenCalled();
  });
});
