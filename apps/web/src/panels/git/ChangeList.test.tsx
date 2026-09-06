import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { GitFileStatus } from "@armadra/shared";

import { ChangeSection, type ChangeActions } from "./ChangeList";
import { usePreferencesStore } from "../../app/preferences-store";

/**
 * 用户实测：源码控制里的文件图标全是「?」。行首那一格原本放的是 Git 状态
 * 字母，未跟踪文件的字母正好是 `?`——在图标位上看就是「图标没加载出来」。
 * 现在行首是文件类型图标，状态字母挪到文件名后面。
 */

const file = (patch: Partial<GitFileStatus> = {}): GitFileStatus => ({
  path: "src/main.rs",
  status: "M",
  staged: false,
  unstaged: true,
  ...patch,
});

const actions: ChangeActions = {
  repositoryPath: ".",
  onHunk: vi.fn(),
  onDiff: vi.fn(),
  onStage: vi.fn(),
  onUnstage: vi.fn(),
  onRestore: vi.fn(),
};

beforeEach(() => {
  usePreferencesStore.setState({ locale: "zh-CN" });
});
afterEach(() => cleanup());

describe("变更列表的一行", () => {
  it("行首是文件类型图标，不是状态字母", () => {
    const { container } = render(
      <ChangeSection
        label="变更"
        rows={[file({ path: "src/main.rs" })]}
        scope="worktree"
        actions={actions}
      />,
    );
    const row = container.querySelector("section > div");
    expect(row?.firstElementChild?.tagName.toLowerCase()).toBe("svg");
    expect(row?.firstElementChild?.getAttribute("class")).toContain(
      "lucide-file-code",
    );
  });

  it("未跟踪文件的图标是文件图标，`?` 只作为状态字母留在行尾", () => {
    const { container } = render(
      <ChangeSection
        label="变更"
        rows={[
          file({
            path: "notes.md",
            status: "?",
            staged: false,
            unstaged: true,
          }),
        ]}
        scope="worktree"
        actions={actions}
      />,
    );
    const row = container.querySelector("section > div");
    expect(row?.firstElementChild?.getAttribute("class")).toContain(
      "lucide-file-text",
    );

    // 状态字母还在，只是不在图标位上：它排在文件名后面。
    const badge = screen.getByTitle("未跟踪");
    expect(badge.textContent).toBe("?");
    expect(
      badge.compareDocumentPosition(screen.getByText("notes.md")) &
        Node.DOCUMENT_POSITION_PRECEDING,
    ).toBeTruthy();
  });
});
