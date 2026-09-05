import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { GitBranchSnapshot } from "@armadra/shared";
import { runtimeApi } from "../../api/client";
import {
  a,
  c,
  commit,
  confirm,
  setupGitRepositoryPanelTests,
  snapshot,
  view,
} from "./GitRepositoryPanel.test-harness";

setupGitRepositoryPanelTests();

describe("remote synchronization", () => {
  function tracked(): GitBranchSnapshot {
    const base = snapshot();
    return {
      ...base,
      branches: [
        ...base.branches,
        {
          name: "origin/main",
          fullRef: "refs/remotes/origin/main",
          oid: c,
          remote: true,
          current: false,
          upstream: null,
          ahead: null,
          behind: null,
          upstreamMissing: false,
          symbolicTarget: null,
        },
      ],
    };
  }
  it("binds sync to the remote OID this view observed and names its steps", async () => {
    vi.mocked(runtimeApi.gitRepositoryBranches).mockResolvedValue(tracked());
    const submit = vi
      .spyOn(runtimeApi, "gitRepositoryOperate")
      .mockImplementation(() => new Promise(() => {}));
    view();
    fireEvent.click(await screen.findByRole("button", { name: "Sync" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toContain(c);
    expect(dialog.textContent).toContain("fast-forward-only pull");
    await confirm();
    await waitFor(() =>
      expect(submit).toHaveBeenCalledWith(
        "workspace-one",
        {
          kind: "sync",
          remote: "origin",
          branch: "main",
          expectedRemoteOid: c,
        },
        { headOid: a, branch: "main" },
        ".",
      ),
    );
  });
  it("pushes without a lease unless one is chosen, and never offers a bare force", async () => {
    vi.mocked(runtimeApi.gitRepositoryBranches).mockResolvedValue(tracked());
    const submit = vi
      .spyOn(runtimeApi, "gitRepositoryOperate")
      .mockImplementation(() => new Promise(() => {}));
    view();
    fireEvent.click(
      await screen.findByRole("button", { name: "Push current branch" }),
    );
    await confirm();
    await waitFor(() =>
      expect(submit).toHaveBeenCalledWith(
        "workspace-one",
        {
          kind: "push",
          remote: "origin",
          branch: "main",
          setUpstream: false,
          forceWithLease: null,
        },
        { headOid: a, branch: "main" },
        ".",
      ),
    );
    expect(screen.queryByRole("button", { name: /^Force push$/ })).toBeNull();
  });
  it("requires a second acknowledgement of the remote commit a lease replaces", async () => {
    vi.mocked(runtimeApi.gitRepositoryBranches).mockResolvedValue(tracked());
    const submit = vi
      .spyOn(runtimeApi, "gitRepositoryOperate")
      .mockImplementation(() => new Promise(() => {}));
    view();
    fireEvent.click(
      await screen.findByLabelText("Push with a force lease instead"),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Force push (with lease)" }),
    );
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toContain("Remote commit this replaces");
    expect(dialog.textContent).toContain(c);
    const action = within(dialog).getByRole("button", {
      name: "Confirm force push",
    });
    expect(action.hasAttribute("disabled")).toBe(true);
    fireEvent.click(action);
    expect(submit).not.toHaveBeenCalled();
    fireEvent.click(
      within(dialog).getByLabelText(
        "I want to rewrite the remote commit above",
      ),
    );
    fireEvent.click(action);
    await waitFor(() =>
      expect(submit).toHaveBeenCalledWith(
        "workspace-one",
        {
          kind: "push",
          remote: "origin",
          branch: "main",
          setUpstream: false,
          forceWithLease: { expectedRemoteOid: c },
        },
        { headOid: a, branch: "main" },
        ".",
      ),
    );
  });
  it("offers no lease while the remote position is unknown", async () => {
    view();
    fireEvent.click(
      await screen.findByLabelText("Push with a force lease instead"),
    );
    expect(
      screen.getByText(/No remote OID has been observed for this branch/),
    ).toBeTruthy();
    const push = screen.getByRole("button", { name: "Push current branch" });
    expect(push.hasAttribute("disabled")).toBe(true);
  });
});
