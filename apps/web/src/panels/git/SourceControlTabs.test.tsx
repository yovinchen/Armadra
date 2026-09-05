import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  useCanvasStore.getState().setPanel("scm", "closed");
  useCanvasStore.setState({ workspace: null });
});
it("keeps Changes as the default and stops its commit shortcut outside that tab", async () => {
  const commit = vi
    .spyOn(runtimeApi, "gitCommit")
    .mockResolvedValue({
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
