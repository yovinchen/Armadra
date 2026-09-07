import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  GitCommitDetail,
  GitCommitFileDiff,
  GitLogCommit,
} from "@armadra/shared";

import { installDomPolyfills } from "@/app/test-harness";
import { usePreferencesStore } from "@/app/preferences-store";
import { CommitDetails } from "./CommitDetails";

installDomPolyfills();

const commitDetail = vi.fn<() => Promise<GitCommitDetail>>();
const commitFile = vi.fn<() => Promise<GitCommitFileDiff>>();

vi.mock("../../../git/gateway", () => ({
  gitGateway: {
    commitDetail: () => commitDetail(),
    commitFile: () => commitFile(),
  },
}));

const oid = (char: string) => char.repeat(40);

const commit: GitLogCommit = {
  repositoryPath: ".",
  oid: oid("a"),
  parents: [oid("b")],
  subject: "fix(web): the thing",
  authorName: "Ada",
  authorEmail: "ada@example.invalid",
  authorTime: "2026-09-01T00:00:00Z",
  committerTime: "2026-09-01T00:00:00Z",
  refs: ["HEAD -> refs/heads/main"],
};

const detail: GitCommitDetail = {
  oid: oid("a"),
  baseOid: oid("b"),
  commit: { ...commit },
  files: [
    { status: "M", path: "apps/web/src/a.ts", additions: 3, deletions: 1 },
    { status: "M", path: "apps/web/src/b.ts", additions: 1, deletions: 0 },
    {
      status: "R",
      path: "old/c.ts -> apps/host/c.ts",
      additions: 0,
      deletions: 0,
    },
  ],
  truncated: false,
};

function view(overrides: Partial<Parameters<typeof CommitDetails>[0]> = {}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <CommitDetails
        workspaceId="workspace"
        target={{ workspaceId: "workspace", repositoryPath: "/project" }}
        commit={commit}
        base={null}
        onBaseChange={() => undefined}
        {...overrides}
      />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  usePreferencesStore.setState({ locale: "en" });
  usePreferencesStore.getState().setGitPreference("flatFiles", false);
  commitDetail.mockResolvedValue(detail);
  commitFile.mockResolvedValue({
    oid: oid("a"),
    baseOid: oid("b"),
    path: "apps/web/src/a.ts",
    patch: "@@ -1 +1 @@\n-old\n+new",
    truncated: false,
  });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("提交详情", () => {
  it("按目录分组，合并只有一条路的段", async () => {
    view();
    await screen.findByText("web/src");
    expect(screen.getByText("a.ts")).toBeTruthy();
    // 重命名的两端都在，新名字是行的标题。
    expect(screen.getByText("old/c.ts", { exact: false })).toBeTruthy();
  });

  it("切到平铺后每一行是完整路径", async () => {
    view();
    await screen.findByText("web/src");
    usePreferencesStore.getState().setGitPreference("flatFiles", true);
    await screen.findByText("apps/web/src/a.ts");
    expect(screen.queryByText("web/src")).toBeNull();
  });

  it("点一个文件在同一栏里展开差异", async () => {
    view();
    fireEvent.click(await screen.findByText("a.ts"));
    await waitFor(() => expect(commitFile).toHaveBeenCalled());
    const pre = await screen.findByLabelText("File diff");
    expect(pre.textContent).toContain("+new");
  });

  it("合并提交才有「与哪个父比」的切换", async () => {
    const onBaseChange = vi.fn();
    const single = view();
    await screen.findByText("web/src");
    expect(screen.queryByText("Compare against")).toBeNull();
    single.unmount();
    view({
      commit: { ...commit, parents: [oid("b"), oid("c")] },
      onBaseChange,
    });
    await screen.findByText("Compare against");
    fireEvent.click(screen.getByText("Parent 2"));
    expect(onBaseChange).toHaveBeenCalledWith(oid("c"));
  });

  it("hash 与 ref 徽标都在最上面", async () => {
    view();
    await screen.findByText(oid("a"));
    expect(screen.getByText("HEAD")).toBeTruthy();
    expect(screen.getByText("main")).toBeTruthy();
  });
});
