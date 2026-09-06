import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { GitIntegrationSnapshot, GitReflogPage } from "@armadra/shared";
import { Reflog, type ReflogProps } from "./Reflog";

// 只替 `useT`：这个组件的复制按钮拉进了终端表面，而它一路把画布 store 也带
// 进来，那个 store 在模块顶层就读偏好设置。
vi.mock("../../app/preferences-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../app/preferences-store")>()),
  useT: () => (key: string) => key,
}));
afterEach(cleanup);

const current = "a".repeat(40);
const lost = "b".repeat(40);

function page(overrides: Partial<GitReflogPage> = {}): GitReflogPage {
  return {
    reference: "HEAD",
    entries: [
      {
        index: 0,
        selector: "HEAD@{0}",
        oid: current,
        previousOid: lost,
        action: "reset",
        message: "moving to HEAD~1",
        committerName: "Author",
        committerEmail: "author@example.test",
        loggedAt: "2026-09-06T12:00:00+08:00",
      },
      {
        index: 1,
        selector: "HEAD@{1}",
        oid: lost,
        previousOid: null,
        action: "commit",
        message: "the work a reset threw away",
        committerName: "Author",
        committerEmail: "author@example.test",
        loggedAt: "2026-09-06T11:00:00+08:00",
      },
    ],
    nextCursor: null,
    ...overrides,
  };
}

const idle: GitIntegrationSnapshot = {
  repositoryId: "repo",
  repositoryPath: "/project",
  head: { headOid: current, branch: "main" },
  stateToken: "f".repeat(64),
  kind: "none",
  owned: false,
  sessionId: null,
  originalHead: null,
  originalBranch: null,
  targetOid: null,
  message: null,
  dirty: false,
  canContinue: false,
  mainline: null,
  empty: false,
  canSkip: false,
  conflicts: [],
};

function setup(overrides: Partial<ReflogProps> = {}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  const props: ReflogProps = {
    workspaceId: "workspace",
    repositoryKey: "repo:/project",
    busy: false,
    loadPage: vi.fn(async () => page()),
    loadState: vi.fn(async () => idle),
    request: vi.fn(),
    ...overrides,
  };
  render(<Reflog {...props} />, {
    wrapper: ({ children }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  });
  return props;
}

it("lists entries newest first with the selector and the time they were logged", async () => {
  const props = setup();
  await screen.findByText("HEAD@{0}");
  expect(screen.getByText("HEAD@{1}")).toBeTruthy();
  // 时间是**条目自己的**时间，不是提交的：checkout 到一年前的提交也是今天记的。
  expect(screen.getByText("2026-09-06T11:00:00+08:00")).toBeTruthy();
  expect(props.loadPage).toHaveBeenCalledWith(
    "HEAD",
    undefined,
    expect.any(AbortSignal),
  );
});

it("recovers a lost commit by its own object ID, never by the selector", async () => {
  const props = setup();
  // 第二行就是被 reset 丢下的那个提交。
  fireEvent.click(await screen.findByText("HEAD@{1}"));
  fireEvent.change(screen.getByLabelText("gitRepo.branchFromCommit"), {
    target: { value: "recovered" },
  });
  fireEvent.click(screen.getByRole("button", { name: "gitRepo.createBranch" }));
  expect(props.request).toHaveBeenCalledExactlyOnceWith({
    kind: "createBranch",
    name: "recovered",
    // `HEAD@{1}` 会随着新条目往前挤而指向别的东西；OID 不会。
    startPoint: lost,
    switch: false,
  });
});

it("checks out and resets from a row, carrying the state it was decided against", async () => {
  const props = setup();
  fireEvent.click(await screen.findByText("HEAD@{1}"));
  fireEvent.click(
    screen.getByRole("button", { name: "gitRepo.checkoutCommit" }),
  );
  expect(props.request).toHaveBeenCalledWith({
    kind: "checkoutCommit",
    targetOid: lost,
  });

  fireEvent.click(screen.getByRole("button", { name: "gitRepo.reset" }));
  expect(props.request).toHaveBeenLastCalledWith({
    kind: "reset",
    mode: "soft",
    targetOid: lost,
    expectedStateToken: idle.stateToken,
    discardChanges: false,
  });
});

it("blocks a hard reset that would discard uncommitted work until it is acknowledged", async () => {
  const props = setup({
    loadState: vi.fn(async () => ({ ...idle, dirty: true })),
  });
  fireEvent.click(await screen.findByText("HEAD@{1}"));
  fireEvent.change(screen.getByLabelText("gitRepo.resetMode"), {
    target: { value: "hard" },
  });
  const reset = screen.getByRole("button", { name: "gitRepo.reset" });
  expect((reset as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(reset);
  expect(props.request).not.toHaveBeenCalled();

  fireEvent.click(screen.getByLabelText("gitRepo.resetDiscard"));
  fireEvent.click(screen.getByRole("button", { name: "gitRepo.reset" }));
  expect(props.request).toHaveBeenCalledExactlyOnceWith({
    kind: "reset",
    mode: "hard",
    targetOid: lost,
    expectedStateToken: idle.stateToken,
    discardChanges: true,
  });
});

it("refuses every recovery while another sequence is in progress", async () => {
  const props = setup({
    loadState: vi.fn(
      async (): Promise<GitIntegrationSnapshot> => ({
        ...idle,
        kind: "rebase",
        owned: true,
      }),
    ),
  });
  fireEvent.click(await screen.findByText("HEAD@{1}"));
  const reset = screen.getByRole("button", { name: "gitRepo.reset" });
  expect((reset as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(reset);
  expect(props.request).not.toHaveBeenCalled();
});
