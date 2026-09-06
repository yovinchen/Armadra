import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const buildEditPreview = vi.fn();
vi.mock("./edit-preview", () => ({
  buildEditPreview: (...args: unknown[]) => buildEditPreview(...args),
}));
vi.mock("@/api/client", () => ({ runtimeApi: {} }));
vi.mock("@/files/open-editor", () => ({ openFileInEditor: vi.fn() }));

import { readActions, runCodeAction, useCodeActionStore } from "./code-actions";
import { useEditPreviewStore } from "./edit-preview-store";

beforeEach(() => {
  buildEditPreview.mockReset().mockResolvedValue({
    workspaceId: "w1",
    sessionId: "s1",
    title: "fix",
    edit: {},
    files: [],
    blocked: false,
  });
  useCodeActionStore.getState().close();
  useEditPreviewStore.getState().close();
});

afterEach(() => {
  useCodeActionStore.getState().close();
  useEditPreviewStore.getState().close();
});

describe("readActions", () => {
  it("keeps actions that carry an edit", () => {
    expect(
      readActions([
        { title: "Remove unused import", kind: "quickfix", edit: {} },
      ]),
    ).toEqual([
      expect.objectContaining({
        title: "Remove unused import",
        kind: "quickfix",
      }),
    ]);
  });

  // 应用一条只有 `command` 的动作要靠 `workspace/executeCommand`，而那是设计
  // §6.2 不开放的。列出来就是一个点了没反应的菜单项。
  it("drops a command-only action rather than offering a dead menu item", () => {
    expect(
      readActions([{ title: "Run codegen", command: { command: "go.run" } }]),
    ).toEqual([]);
    // 同时带 edit 的仍然留着：能应用的那一半是真的。
    expect(
      readActions([
        { title: "Organise imports", command: { command: "x" }, edit: {} },
      ]),
    ).toHaveLength(1);
  });

  it("ignores entries that are not actions at all", () => {
    expect(readActions([null, 3, {}, { title: "" }] as unknown[])).toEqual([]);
  });
});

describe("runCodeAction", () => {
  it("sends the action's edit through the preview rather than to the buffer", async () => {
    useCodeActionStore.getState().begin({
      workspaceId: "w1",
      uri: "armadra:///src/main.py",
    });
    useCodeActionStore
      .getState()
      .show(
        readActions([
          { title: "fix", kind: "quickfix", edit: { changes: {} } },
        ]),
        "s1",
      );
    const [action] = useCodeActionStore.getState().actions;
    await runCodeAction(action!);

    expect(buildEditPreview).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "w1",
        sessionId: "s1",
        title: "fix",
        edit: { changes: {} },
      }),
    );
    expect(useEditPreviewStore.getState().preview).not.toBeNull();
    // 菜单关掉，预览接手：两个浮层同时开着谁也说不清在等哪一个。
    expect(useCodeActionStore.getState().open).toBe(false);
  });

  it("says an action carries nothing to apply instead of doing nothing", async () => {
    useCodeActionStore.getState().begin({
      workspaceId: "w1",
      uri: "armadra:///src/main.py",
    });
    useCodeActionStore
      .getState()
      .show([{ title: "empty", raw: { title: "empty" } }], "s1");
    await runCodeAction(useCodeActionStore.getState().actions[0]!);

    expect(buildEditPreview).not.toHaveBeenCalled();
    expect(useEditPreviewStore.getState().error).toBe(
      "这条操作没有可应用的修改",
    );
  });
});
