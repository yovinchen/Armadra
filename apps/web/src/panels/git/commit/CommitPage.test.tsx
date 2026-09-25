import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  GitIntegrationSnapshot,
  GitRepositoryList,
  GitStatusBatch,
  Workspace,
} from "@armadra/shared";
import { runtimeApi } from "../../../api/client";
import { usePreferencesStore } from "../../../app/preferences-store";
import { installDomPolyfills } from "../../../app/test-harness";
import { gitGateway } from "../../../git/gateway";
import { useCanvasStore } from "../../../store/canvas-store";
import { CommitPage } from "./CommitPage";

installDomPolyfills();

const timestamp = "2026-09-07T00:00:00Z";
const workspace: Workspace = {
  id: "019ff7d1-0d12-7421-833d-2c5e8d64ed21",
  name: "repo",
  rootPath: "/repo",
  color: "#5B5BD6",
  permissions: { read: true, write: true, execute: true },
  executionHostId: "",
  lastOpenedAt: timestamp,
  createdAt: timestamp,
  updatedAt: timestamp,
};

function repositories(paths: string[]): GitRepositoryList {
  return {
    repositories: paths.map((path, index) => ({
      repositoryId: `repo-${index}`,
      repositoryPath: path,
      name: path === "." ? "repo" : path.split("/").at(-1)!,
      kind: path === "." ? ("root" as const) : ("nested" as const),
      parentRepositoryId: null,
      headBranch: "main",
      dirtyCount: 1,
    })),
    truncated: false,
    observedAt: timestamp,
    workspaceRoot: workspace.rootPath,
    maxDepth: 4,
  };
}

function batch(
  entries: {
    path: string;
    files: {
      path: string;
      status: "M" | "A" | "D" | "R" | "?";
      staged: boolean;
      unstaged: boolean;
    }[];
  }[],
): GitStatusBatch {
  return {
    repositories: entries.map((entry) => ({
      path: entry.path,
      status: {
        repository: true,
        branch: "main",
        changedCount: entry.files.length,
        // `originPath` 是重命名的来源，Runtime 现在会给出来；这些用例不关心它，
        // 但缺了它这份桩就不再是一份 `git status` 了。
        files: entry.files.map((file) => ({ ...file, originPath: null })),
      },
    })),
    observedAt: timestamp,
  };
}

function idle(path: string): GitIntegrationSnapshot {
  return {
    repositoryId: "repo-0",
    repositoryPath: path,
    head: { headOid: "a".repeat(40), branch: "main" },
    stateToken: "d".repeat(64),
    kind: "none",
    owned: false,
    sessionId: null,
    originalHead: null,
    originalBranch: null,
    targetOid: null,
    message: null,
    dirty: true,
    canContinue: false,
    mainline: null,
    empty: false,
    canSkip: false,
    conflicts: [],
  };
}

/**
 * 一份会跟着写变的状态快照。乐观更新之后紧接着就是一次真的重读，用固定桩
 * 只能验到「界面自己改了一下」，验不到那次重读回来之后它是不是还对。
 */
function livingBatch(entries: Parameters<typeof batch>[0]): {
  read: () => GitStatusBatch;
  apply: (repositoryPath: string, paths: string[], staged: boolean) => void;
} {
  const state = structuredClone(entries);
  return {
    read: () => batch(state),
    apply: (repositoryPath, paths, staged) => {
      const entry = state.find((item) => item.path === repositoryPath)!;
      for (const file of entry.files)
        if (paths.includes(file.path)) {
          file.staged = staged;
          file.unstaged = !staged;
        }
    },
  };
}

const clients: QueryClient[] = [];
function view() {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity },
      mutations: { retry: false },
    },
  });
  clients.push(client);
  return {
    client,
    ...render(
      <QueryClientProvider client={client}>
        <CommitPage workspaceId={workspace.id} />
      </QueryClientProvider>,
    ),
  };
}

beforeEach(() => {
  usePreferencesStore.setState({ locale: "en" });
  useCanvasStore.setState({ workspace });
  vi.spyOn(gitGateway, "operation").mockImplementation(
    () => new Promise(() => {}),
  );
  vi.spyOn(runtimeApi, "gitHeadCommit").mockResolvedValue(null);
});
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
  vi.restoreAllMocks();
});

/** 变更树读回来了：树上第一行出现之后才谈得上勾选与提交。 */
function ready() {
  return screen.findByRole("treeitem", { name: /a\.ts/ });
}

/** 提交信息输入框；同一句话也是分区标题，所以按角色取。 */
function messageBox() {
  return screen.findByRole("textbox", { name: "Commit message" });
}

describe("checkbox to index mapping", () => {
  beforeEach(() => {
    vi.spyOn(gitGateway, "repositories").mockResolvedValue(repositories(["."]));
    vi.spyOn(gitGateway, "integration").mockResolvedValue(idle("."));
  });

  it("stages the file it was clicked on and shows it as included right away", async () => {
    const living = livingBatch([
      {
        path: ".",
        files: [
          { path: "src/a.ts", status: "M", staged: false, unstaged: true },
        ],
      },
    ]);
    vi.spyOn(gitGateway, "statusBatch").mockImplementation(async () =>
      living.read(),
    );
    const stage = vi
      .spyOn(gitGateway, "stage")
      .mockImplementation(async (_target, paths) => {
        living.apply(".", paths, true);
        return { staged: paths };
      });
    view();
    fireEvent.click(await screen.findByRole("checkbox", { name: "Stage" }));
    await waitFor(() => expect(stage).toHaveBeenCalledTimes(1));
    expect(stage.mock.calls[0]![1]).toEqual(["src/a.ts"]);
    // 勾上之后这一行进「已暂存」，而且重读回来之后仍然在那里。
    await screen.findByRole("checkbox", { name: "Unstage" });
    expect(screen.getByText("Staged")).toBeTruthy();
  });

  it("unstages a staged row", async () => {
    const living = livingBatch([
      {
        path: ".",
        files: [
          { path: "src/a.ts", status: "M", staged: true, unstaged: false },
        ],
      },
    ]);
    vi.spyOn(gitGateway, "statusBatch").mockImplementation(async () =>
      living.read(),
    );
    const unstage = vi
      .spyOn(gitGateway, "unstage")
      .mockImplementation(async (_target, paths) => {
        living.apply(".", paths, false);
        return { unstaged: paths };
      });
    view();
    fireEvent.click(await screen.findByRole("checkbox", { name: "Unstage" }));
    await waitFor(() => expect(unstage).toHaveBeenCalledTimes(1));
    expect(unstage.mock.calls[0]![1]).toEqual(["src/a.ts"]);
    await screen.findByRole("checkbox", { name: "Stage" });
  });

  it("rolls the checkbox back when the write fails", async () => {
    vi.spyOn(gitGateway, "statusBatch").mockResolvedValue(
      batch([
        {
          path: ".",
          files: [
            { path: "src/a.ts", status: "M", staged: false, unstaged: true },
          ],
        },
      ]),
    );
    vi.spyOn(gitGateway, "stage").mockRejectedValue(new Error("locked"));
    view();
    fireEvent.click(await screen.findByRole("checkbox", { name: "Stage" }));
    // 失败之后那一行必须回到未勾选：一个停在错误位置的复选框会让人以为文件
    // 已经在这次提交里了。
    await waitFor(() =>
      expect(screen.getAllByRole("checkbox", { name: "Stage" })).toHaveLength(
        1,
      ),
    );
    expect(screen.queryByRole("checkbox", { name: "Unstage" })).toBeNull();
  });

  it("stages every file under a directory in one request", async () => {
    vi.spyOn(gitGateway, "statusBatch").mockResolvedValue(
      batch([
        {
          path: ".",
          files: [
            { path: "src/a.ts", status: "M", staged: false, unstaged: true },
            { path: "src/b.ts", status: "M", staged: false, unstaged: true },
          ],
        },
      ]),
    );
    const stage = vi
      .spyOn(gitGateway, "stage")
      .mockResolvedValue({ staged: ["src/a.ts", "src/b.ts"] });
    view();
    // 第一个复选框是目录 `src`，后面两个是文件。
    fireEvent.click(await screen.findByRole("checkbox", { name: /^Include/ }));
    await waitFor(() => expect(stage).toHaveBeenCalledTimes(1));
    expect(stage.mock.calls[0]![1]).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("marks a conflict resolved instead of a plain add, and never pre-checks it", async () => {
    vi.spyOn(gitGateway, "statusBatch").mockResolvedValue(
      batch([
        {
          path: ".",
          files: [
            { path: "src/a.ts", status: "M", staged: true, unstaged: true },
          ],
        },
      ]),
    );
    vi.spyOn(gitGateway, "integration").mockResolvedValue({
      ...idle("."),
      kind: "merge",
      owned: true,
      sessionId: "11111111-1111-4111-8111-111111111111",
      canContinue: false,
      conflicts: [{ path: "src/a.ts", base: null, ours: null, theirs: null }],
    });
    const resolved = vi
      .spyOn(gitGateway, "markResolved")
      .mockResolvedValue({ resolved: ["src/a.ts"] });
    const stage = vi.spyOn(gitGateway, "stage");
    view();
    // 冲突行显示成未勾选，哪怕 porcelain 的 `UU` 两列都非空。
    const checkbox = await screen.findByRole("checkbox", { name: "Stage" });
    fireEvent.click(checkbox);
    await waitFor(() => expect(resolved).toHaveBeenCalledTimes(1));
    expect(stage).not.toHaveBeenCalled();
  });
});

describe("layout in the docked window", () => {
  beforeEach(() => {
    vi.spyOn(gitGateway, "repositories").mockResolvedValue(repositories(["."]));
    vi.spyOn(gitGateway, "integration").mockResolvedValue(idle("."));
    vi.spyOn(gitGateway, "statusBatch").mockResolvedValue(
      livingBatch([
        {
          path: ".",
          files: [
            { path: "src/a.ts", status: "M", staged: true, unstaged: false },
          ],
        },
      ]).read(),
    );
  });

  it("scrolls as a whole when it does not fit, so the commit button stays reachable", async () => {
    // 窗口停在底部时默认只有 40vh：1440×900 下是 360px。工具条、变更树的
    // 128px 下限与消息区加起来超过它，而这一页原来不滚动，「提交」按钮落在
    // 视口下沿之外，点不到（远端探针实测，按钮顶边在 914px）。jsdom 量不出
    // 布局，这里守住的是「这一页自己是滚动容器」。
    const { container } = view();
    await ready();
    const page = container.firstElementChild as HTMLElement;
    expect(page.className).toContain("overflow-y-auto");
    expect(page.contains(screen.getByRole("button", { name: "Commit" }))).toBe(
      true,
    );
  });
});

describe("cross-repository commit", () => {
  beforeEach(() => {
    vi.spyOn(gitGateway, "repositories").mockResolvedValue(
      repositories([".", "packages/foo"]),
    );
    vi.spyOn(gitGateway, "integration").mockImplementation(async (target) =>
      idle(target.path ?? "."),
    );
    vi.spyOn(gitGateway, "statusBatch").mockResolvedValue(
      batch([
        {
          path: ".",
          files: [{ path: "a.ts", status: "M", staged: true, unstaged: false }],
        },
        {
          path: "packages/foo",
          files: [
            { path: "b.ts", status: "M", staged: true, unstaged: false },
            { path: "c.ts", status: "M", staged: false, unstaged: true },
          ],
        },
      ]),
    );
  });

  it("commits once per repository with the same message", async () => {
    const commit = vi.spyOn(gitGateway, "commit").mockResolvedValue({
      commit: "abc1234",
      committed: ["abc1234"],
      summary: "",
    });
    view();
    await ready();
    fireEvent.change(await messageBox(), {
      target: { value: "fix: two repositories" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Commit" }));
    await waitFor(() => expect(commit).toHaveBeenCalledTimes(2));
    expect(commit.mock.calls.map((call) => call[0].path)).toEqual([
      ".",
      "packages/foo",
    ]);
    expect(commit.mock.calls.map((call) => call[1])).toEqual([
      "fix: two repositories",
      "fix: two repositories",
    ]);
    // 每个仓库一个种子：Host 认得出重放，两次提交不能共用一个。
    expect(commit.mock.calls[0]![2]).not.toBe(commit.mock.calls[1]![2]);
    // 索引就是这次提交的内容，所以不另外送一份路径列表。
    expect(commit.mock.calls[0]![3]).toBeUndefined();
  });

  it("keeps the repositories that did commit when a later one fails", async () => {
    vi.spyOn(gitGateway, "commit")
      .mockResolvedValueOnce({
        commit: "abc1234",
        committed: ["abc1234"],
        summary: "",
      })
      .mockRejectedValueOnce(new Error("index.lock exists"));
    view();
    await ready();
    fireEvent.change(await messageBox(), {
      target: { value: "fix: two repositories" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Commit" }));
    const progress = await screen.findByRole("list", {
      name: "Commit progress",
    });
    await waitFor(() =>
      expect(within(progress).getByText("abc1234")).toBeTruthy(),
    );
    expect(within(progress).getByText(/index\.lock exists/)).toBeTruthy();
  });

  it("does not offer an amend across repositories", async () => {
    view();
    await ready();
    const amend = screen.getByRole("checkbox", {
      name: "Amend the previous commit",
    }) as HTMLInputElement;
    expect(amend.disabled).toBe(true);
    expect(
      screen.getByText(/Amending is not offered across repositories/),
    ).toBeTruthy();
  });

  it("asks for confirmation before the push half of commit and push", async () => {
    vi.spyOn(gitGateway, "commit").mockResolvedValue({
      commit: "abc1234",
      committed: ["abc1234"],
      summary: "",
    });
    const branches = vi.spyOn(gitGateway, "branches").mockResolvedValue({
      repositoryId: "repo-0",
      repositoryPath: "/repo",
      head: { headOid: "a".repeat(40), branch: "main" },
      remotes: ["origin"],
      observedAt: timestamp,
      branches: [
        {
          name: "main",
          fullRef: "refs/heads/main",
          oid: "a".repeat(40),
          remote: false,
          current: true,
          upstream: "origin/main",
          ahead: 1,
          behind: 0,
          upstreamMissing: false,
          symbolicTarget: null,
        },
      ],
    });
    const operate = vi.spyOn(gitGateway, "operate");
    view();
    await ready();
    fireEvent.change(await messageBox(), {
      target: { value: "fix: push me" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Commit and push" }));
    await screen.findByRole("alertdialog");
    expect(branches).toHaveBeenCalled();
    // 推送在被确认之前一条都没排出去。
    expect(operate).not.toHaveBeenCalled();
  });
});
