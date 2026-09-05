import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { workspaceSchema } from "@armadra/shared";
import { runtimeApi } from "../../api/client";
import { useCanvasStore } from "../../store/canvas-store";
import { usePreferencesStore } from "../../app/preferences-store";
import { TestProviders, installDomPolyfills } from "../../app/test-harness";
import { SourceControlDrawer, SCM_COMMIT_EVENT } from "../SourceControlDrawer";

installDomPolyfills();
beforeEach(() => {
  usePreferencesStore.setState({ locale: "en" });
  useCanvasStore.setState({
    workspace: workspaceSchema.parse({
      id: "019ff7d1-0d12-7421-833d-2c5e8d64ed21",
      name: "Git fixture",
      rootPath: "/fixture",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      lastOpenedAt: "2026-01-01T00:00:00Z",
    }),
  });
  useCanvasStore.getState().setPanel("scm", "drawer");
  vi.spyOn(runtimeApi, "gitStatus").mockResolvedValue({
    repository: true,
    branch: "main",
    files: [],
    changedCount: 0,
    ahead: 0,
    behind: 0,
  });
  vi.spyOn(runtimeApi, "gitRepositoryBranches").mockResolvedValue({
    repositoryId: "fixture",
    repositoryPath: "/fixture",
    head: { headOid: null, branch: "main" },
    branches: [],
    remotes: [],
    observedAt: "now",
  });
});

it("refreshes AI source after staging the first file without generating automatically", async () => {
  let staged = false;
  vi.mocked(runtimeApi.gitStatus).mockImplementation(async () => ({
    repository: true,
    branch: "main",
    files: [{ path: "feature.ts", status: "M", staged, unstaged: !staged }],
    changedCount: 1,
    ahead: 0,
    behind: 0,
  }));
  vi.spyOn(runtimeApi, "gitMessageProviders").mockResolvedValue([
    { id: "claude-bare", label: "Claude", available: true, reason: null },
  ]);
  const source = vi
    .spyOn(runtimeApi, "gitMessageSource")
    .mockImplementation(async () => ({
      expectedHead: "a".repeat(40),
      indexDigest: "b".repeat(64),
      sourceDigest: "c".repeat(64),
      includedFiles: staged ? ["feature.ts"] : [],
      excludedFiles: [],
      truncated: false,
      redacted: false,
    }));
  const generate = vi.spyOn(runtimeApi, "gitMessageGenerate");
  vi.spyOn(runtimeApi, "gitStage").mockImplementation(async () => {
    staged = true;
    return { staged: ["feature.ts"] };
  });
  render(
    <TestProviders>
      <SourceControlDrawer />
    </TestProviders>,
  );
  const details = (await screen.findAllByText("AI commit-message draft")).find(
    (element) => element.tagName === "SUMMARY",
  )!;
  fireEvent.click(details);
  const button = await screen.findByRole("button", { name: "Generate draft" });
  expect((button as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(await screen.findByRole("button", { name: "Stage" }));
  await waitFor(() =>
    expect((button as HTMLButtonElement).disabled).toBe(false),
  );
  expect(source.mock.calls.length).toBeGreaterThan(1);
  expect(generate).not.toHaveBeenCalled();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  useCanvasStore.getState().setPanel("scm", "closed");
  useCanvasStore.setState({ workspace: null });
});
it("keeps Changes as the default and stops its commit shortcut outside that tab", async () => {
  const commit = vi.spyOn(runtimeApi, "gitCommit").mockResolvedValue({
    commit: "a".repeat(40),
    committed: [],
    summary: "fixture",
  });
  render(
    <TestProviders>
      <SourceControlDrawer />
    </TestProviders>,
  );
  expect(
    screen.getByRole("tab", { name: "Changes" }).getAttribute("aria-selected"),
  ).toBe("true");
  expect(screen.getAllByRole("tab")).toHaveLength(5);
  fireEvent.change(screen.getByRole("textbox"), {
    target: { value: "draft commit" },
  });
  fireEvent.keyDown(screen.getByRole("tab", { name: "Branches" }), {
    key: "Enter",
  });
  await screen.findByText("No branches yet");
  fireEvent(window, new CustomEvent(SCM_COMMIT_EVENT));
  expect(commit).not.toHaveBeenCalled();
  expect(screen.queryByRole("textbox", { name: "Commit message" })).toBeNull();
  expect(screen.getByRole("dialog").className).toContain("max-w-full");
});
