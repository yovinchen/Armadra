import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  GitHunkDiff,
  GitHunkMutation,
  GitHunkResult,
} from "@armadra/shared";
import { usePreferencesStore } from "../../app/preferences-store";
import { installDomPolyfills } from "../../app/test-harness";
import { ChangesHunks, type ChangesHunksProps } from "./ChangesHunks";

installDomPolyfills();
const digest = "a".repeat(64),
  first = "b".repeat(64),
  second = "c".repeat(64);
function diff(
  file = "file with spaces.txt",
  scope: GitHunkDiff["scope"] = "worktree",
): GitHunkDiff {
  return {
    file,
    scope,
    diffDigest: digest,
    supported: true,
    unsupportedReason: null,
    hunks: [
      {
        id: first,
        header: "@@ -1,2 +1,2 @@",
        content: "-old one\n+new one\n context\n",
        oldStart: 1,
        oldLines: 2,
        newStart: 1,
        newLines: 2,
      },
      {
        id: second,
        header: "@@ -20,2 +20,2 @@",
        content: "-old twenty\n+new twenty\n context\n",
        oldStart: 20,
        oldLines: 2,
        newStart: 20,
        newLines: 2,
      },
    ],
  };
}
const clients: QueryClient[] = [];
function view(overrides: Partial<ChangesHunksProps> = {}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  clients.push(client);
  const props: ChangesHunksProps = {
    workspaceId: "workspace",
    file: "file with spaces.txt",
    scope: "worktree",
    load: vi.fn(async (_workspace, file, scope) => diff(file, scope)),
    apply: vi.fn(async (_workspace, request) => ({
      applied: true,
      ...request,
    })),
    onChanged: vi.fn(),
    ...overrides,
  };
  const ui = (next = props) => (
    <QueryClientProvider client={client}>
      <ChangesHunks {...next} />
    </QueryClientProvider>
  );
  return { ...render(ui()), props, client, ui };
}
beforeEach(() => usePreferencesStore.setState({ locale: "en" }));
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
});

describe("individual changes hunks", () => {
  it("submits only observed identifiers for the chosen stage hunk, never patch bytes", async () => {
    const { props } = view();
    const buttons = await screen.findAllByRole("button", {
      name: "Stage this hunk",
    });
    fireEvent.click(buttons[1]!);
    await screen.findByText("Hunk operation completed");
    expect(props.apply).toHaveBeenCalledWith("workspace", {
      // 检出路径跟着请求走，缺省是根：同名文件在两个仓库里是两个文件。
      path: ".",
      file: "file with spaces.txt",
      scope: "worktree",
      diffDigest: digest,
      hunkId: second,
      action: "stage",
    });
    expect(props.onChanged).toHaveBeenCalledWith(
      "workspace",
      "file with spaces.txt",
      "worktree",
    );
    const request = vi.mocked(props.apply).mock.calls[0]![1];
    expect(Object.keys(request).sort()).toEqual([
      "action",
      "diffDigest",
      "file",
      "hunkId",
      "path",
      "scope",
    ]);
  });
  it("requires confirmation showing the exact selected hunk before discarding", async () => {
    const { props } = view();
    fireEvent.click(
      (await screen.findAllByRole("button", { name: "Discard this hunk" }))[1]!,
    );
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toContain("file with spaces.txt");
    expect(dialog.textContent).toContain("+new twenty");
    expect(dialog.textContent).not.toContain("+new one");
    expect(props.apply).not.toHaveBeenCalled();
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Discard this hunk" }),
    );
    await waitFor(() =>
      expect(props.apply).toHaveBeenCalledWith(
        "workspace",
        expect.objectContaining({ action: "revert", hunkId: second }),
      ),
    );
  });
  it("disables a stale confirmation instead of discarding newly changed content", async () => {
    const { client, props } = view();
    fireEvent.click(
      (await screen.findAllByRole("button", { name: "Discard this hunk" }))[0]!,
    );
    const changed = { ...diff(), diffDigest: "d".repeat(64) };
    act(() =>
      client.setQueryData(
        ["git-hunks", "workspace", ".", "file with spaces.txt", "worktree"],
        changed,
      ),
    );
    const dialog = screen.getByRole("alertdialog");
    await waitFor(() =>
      expect(
        (
          within(dialog).getByRole("button", {
            name: "Discard this hunk",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(true),
    );
    expect(within(dialog).getByRole("alert").textContent).toContain(
      "file changed",
    );
    expect(props.apply).not.toHaveBeenCalled();
  });
  it("offers only unstage for an index diff", async () => {
    const { props } = view({ scope: "staged" });
    fireEvent.click(
      (await screen.findAllByRole("button", { name: "Unstage this hunk" }))[0]!,
    );
    await waitFor(() =>
      expect(props.apply).toHaveBeenCalledWith(
        "workspace",
        expect.objectContaining({ scope: "staged", action: "unstage" }),
      ),
    );
    expect(
      screen.queryByRole("button", { name: "Discard this hunk" }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Stage this hunk" }),
    ).toBeNull();
  });
  it("keeps unsupported files read-only and points back to whole-file operations", async () => {
    view({
      load: vi.fn(async () => ({
        ...diff(),
        supported: false,
        unsupportedReason: "binary",
        hunks: [],
      })),
    });
    expect(
      await screen.findByText("Use whole-file operations for binary files."),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Stage this hunk" }),
    ).toBeNull();
  });
  it("does not report a malformed or failed response as success or retry a write", async () => {
    const apply = vi.fn(async () => {
      throw new Error("Connection lost after request");
    });
    view({ apply });
    fireEvent.click(
      (await screen.findAllByRole("button", { name: "Stage this hunk" }))[0]!,
    );
    await screen.findByText(/It will not retry automatically/);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Hunk operation completed")).toBeNull();
  });
  it("drops stale local success and callbacks after a workspace/file switch", async () => {
    let resolve!: (result: GitHunkResult) => void;
    const apply = vi.fn(
      (_workspace: string, _request: GitHunkMutation) =>
        new Promise<GitHunkResult>((done) => {
          resolve = done;
        }),
    );
    const rendered = view({ apply });
    fireEvent.click(
      (await screen.findAllByRole("button", { name: "Stage this hunk" }))[0]!,
    );
    await waitFor(() => expect(apply).toHaveBeenCalledTimes(1));
    rendered.rerender(
      rendered.ui({
        ...rendered.props,
        workspaceId: "other-workspace",
        file: "other.txt",
      }),
    );
    await screen.findByText("other.txt");
    await act(async () =>
      resolve({
        applied: true,
        file: "file with spaces.txt",
        scope: "worktree",
        action: "stage",
        hunkId: first,
      }),
    );
    expect(screen.queryByText("Hunk operation completed")).toBeNull();
    expect(rendered.props.onChanged).not.toHaveBeenCalled();
  });
});
