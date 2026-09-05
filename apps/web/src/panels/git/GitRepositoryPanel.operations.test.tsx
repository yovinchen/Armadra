import { describe, expect, it, vi } from "vitest";
import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type {
  GitRepositoryAction,
  GitRepositoryOperation,
} from "@armadra/shared";
import { RuntimeConnectionError, runtimeApi } from "../../api/client";
import {
  a,
  confirm,
  operation,
  setupGitRepositoryPanelTests,
  snapshot,
  view,
} from "./GitRepositoryPanel.test-harness";

setupGitRepositoryPanelTests();

describe("repository operations", () => {
  it("restores a running operation from the Runtime after a fresh page query cache", async () => {
    const restored = operation(
      { kind: "fetch", remote: "origin", prune: false },
      "running",
    );
    vi.mocked(runtimeApi.gitRepositoryOperations).mockResolvedValue([restored]);
    const cancel = vi
      .spyOn(runtimeApi, "gitRepositoryCancel")
      .mockResolvedValue({ ...restored, state: "cancelled" });
    view();
    const region = await screen.findByRole("region", {
      name: "Operation status",
    });
    expect(region.textContent).toContain("origin");
    fireEvent.click(
      within(region).getByRole("button", { name: "Request cancellation" }),
    );
    await waitFor(() =>
      expect(cancel).toHaveBeenCalledWith("workspace-one", restored.id),
    );
  });
  it("confirms the branch and observed HEAD, then waits for the actual result and supports cancellation", async () => {
    const action: GitRepositoryAction = {
      kind: "createBranch",
      name: "feature/new",
      startPoint: null,
      switch: false,
    };
    const submit = vi
      .spyOn(runtimeApi, "gitRepositoryOperate")
      .mockResolvedValue(operation(action));
    vi.spyOn(runtimeApi, "gitRepositoryCancel").mockResolvedValue({
      ...operation(action, "unknownOutcome"),
      cancellationRequested: true,
      message: "Inspect remote before retrying",
    });
    view();
    fireEvent.change(
      await screen.findByRole("textbox", { name: "Branch name" }),
      { target: { value: "feature/new" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "Create branch" }));
    expect(submit).not.toHaveBeenCalled();
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toContain("/project");
    expect(dialog.textContent).toContain(a);
    await confirm();
    await waitFor(() =>
      expect(submit).toHaveBeenCalledWith(
        "workspace-one",
        action,
        { headOid: a, branch: "main" },
        ".",
      ),
    );
    expect(
      await screen.findByRole("region", { name: "Operation status" }),
    ).toBeTruthy();
    expect(screen.queryByText(/Completed/)).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "Request cancellation" }),
    );
    await screen.findByText(/Outcome unknown/);
    expect(screen.queryByText(/Completed/)).toBeNull();
    expect(screen.getByText(/It will not retry automatically/)).toBeTruthy();
  });

  it("keeps a pending submission across panel close/reopen and scopes its late response to its workspace", async () => {
    let resolve!: (value: GitRepositoryOperation) => void;
    const submit = vi
      .spyOn(runtimeApi, "gitRepositoryOperate")
      .mockImplementation(
        () =>
          new Promise((done) => {
            resolve = done;
          }),
      );
    const rendered = view();
    fireEvent.click(await screen.findByRole("button", { name: "Fetch" }));
    await confirm();
    await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
    rendered.rerender(rendered.ui("workspace-one", false));
    rendered.rerender(rendered.ui());
    const fetch = await screen.findByRole("button", { name: "Fetch" });
    expect(fetch.closest("fieldset")?.disabled).toBe(true);
    vi.mocked(runtimeApi.gitRepositoryBranches).mockResolvedValue(
      snapshot("repo-two"),
    );
    rendered.rerender(rendered.ui("workspace-two"));
    await waitFor(() =>
      expect(vi.mocked(runtimeApi.gitRepositoryBranches)).toHaveBeenCalledWith(
        "workspace-two",
        ".",
        expect.any(AbortSignal),
      ),
    );
    await act(async () =>
      resolve(
        operation(
          { kind: "fetch", remote: "origin", prune: false },
          "succeeded",
        ),
      ),
    );
    expect(
      screen.queryByRole("region", { name: "Operation status" }),
    ).toBeNull();
    expect(screen.queryByText(/Completed/)).toBeNull();
  });

  it("never retries an uncertain write and keeps it blocked until explicit inspection", async () => {
    const submit = vi
      .spyOn(runtimeApi, "gitRepositoryOperate")
      .mockRejectedValue(new RuntimeConnectionError("http://fixture.invalid"));
    const rendered = view();
    fireEvent.click(
      await screen.findByRole("button", { name: "Push current branch" }),
    );
    expect((await screen.findByRole("alertdialog")).textContent).toContain(
      "origin / main",
    );
    await confirm();
    await screen.findByText(/It will not retry automatically/);
    expect(submit).toHaveBeenCalledTimes(1);
    rendered.rerender(rendered.ui("workspace-one", false));
    rendered.rerender(rendered.ui());
    const fetch = await screen.findByRole("button", { name: "Fetch" });
    expect(fetch.closest("fieldset")?.disabled).toBe(true);
    fireEvent.click(
      screen.getByRole("button", {
        name: "I checked the state; enable operations",
      }),
    );
    await waitFor(() =>
      expect(fetch.closest("fieldset")?.disabled).toBe(false),
    );
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it("shows failed reads rather than a clean or empty repository", async () => {
    vi.mocked(runtimeApi.gitRepositoryBranches).mockRejectedValue(
      new Error("Repository unavailable"),
    );
    view();
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.queryByText("No branches yet")).toBeNull();
    expect(screen.queryByRole("button", { name: "Create branch" })).toBeNull();
  });

  it("stops polling after a read error and resumes only on explicit check", async () => {
    const action: GitRepositoryAction = {
      kind: "fetch",
      remote: "origin",
      prune: false,
    };
    vi.spyOn(runtimeApi, "gitRepositoryOperate").mockResolvedValue(
      operation(action),
    );
    vi.mocked(runtimeApi.gitRepositoryOperation).mockRejectedValue(
      new Error("lost connection"),
    );
    view();
    fireEvent.click(await screen.findByRole("button", { name: "Fetch" }));
    await confirm();
    await screen.findByText(/cannot be read right now/);
    expect(vi.mocked(runtimeApi.gitRepositoryOperation)).toHaveBeenCalledTimes(
      1,
    );
    vi.mocked(runtimeApi.gitRepositoryOperation).mockResolvedValue(
      operation(action, "succeeded"),
    );
    fireEvent.click(screen.getByRole("button", { name: "Check result again" }));
    await screen.findByText(/Completed/);
    expect(vi.mocked(runtimeApi.gitRepositoryOperation)).toHaveBeenCalledTimes(
      2,
    );
  });
});
