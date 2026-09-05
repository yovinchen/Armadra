import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import type { GitRepositoryOperation } from "@armadra/shared";
import { runtimeApi } from "../../api/client";
import {
  a,
  cachedOperationKey,
  commit,
  confirm,
  integrationState,
  mergeId,
  operation,
  setupGitRepositoryPanelTests,
  view,
  waitingMerge,
} from "./GitRepositoryPanel.test-harness";

setupGitRepositoryPanelTests();

describe("integration operation reconciliation", () => {
  it("rechecks external completion, updates old waiting history to unknown, and stops invalidating once reconciled", async () => {
    let history = [waitingMerge()];
    let external = false;
    const list = vi
      .mocked(runtimeApi.gitRepositoryOperations)
      .mockImplementation(async () => history);
    const read = vi
      .spyOn(runtimeApi, "gitRepositoryIntegration")
      .mockImplementation(async () => {
        if (!external) return integrationState();
        history = [
          {
            ...waitingMerge(),
            state: "unknownOutcome",
            finishedAt: "2026-09-05T00:00:02Z",
            message: "External completion released ownership",
          },
        ];
        return {
          ...integrationState(),
          kind: "none",
          owned: false,
          sessionId: null,
          canContinue: false,
          mainline: null,
          empty: false,
          canSkip: false,
          dirty: false,
          message: null,
        };
      });
    const { client } = view("integration");
    const region = await screen.findByRole("region", {
      name: "Operation status",
    });
    await waitFor(() =>
      expect(region.textContent).toContain("Awaiting resolution"),
    );
    await screen.findByText(
      "The merge is ready and still awaits your commit confirmation.",
    );
    external = true;
    // The second Refresh belongs to the integration view, not the global button.
    fireEvent.click(
      screen.getAllByRole("button", { name: "Refresh repository" })[1]!,
    );
    await waitFor(() =>
      expect(region.textContent).toContain("Outcome unknown"),
    );
    expect(region.textContent).not.toContain("Awaiting resolution");
    expect(
      client.getQueryData<GitRepositoryOperation>(cachedOperationKey(mergeId))
        ?.state,
    ).toBe("unknownOutcome");
    const tracked = client.getQueryData<{ operation: GitRepositoryOperation }>([
      "git-repository-active-operation",
      "workspace-one",
      "repo-one",
      "/project",
    ]);
    expect(tracked?.operation.state).toBe("unknownOutcome");
    await act(async () => new Promise((resolve) => setTimeout(resolve, 30)));
    const counts = [read.mock.calls.length, list.mock.calls.length];
    await act(async () => new Promise((resolve) => setTimeout(resolve, 40)));
    expect([read.mock.calls.length, list.mock.calls.length]).toEqual(counts);
    expect(counts[0]).toBeLessThan(8);
  });

  it.each([false, true])(
    "refreshes the original start record after explicit recovery (abort=%s)",
    async (abort) => {
      let history = [waitingMerge()];
      let active = true;
      vi.mocked(runtimeApi.gitRepositoryOperations).mockImplementation(
        async () => history,
      );
      vi.spyOn(runtimeApi, "gitRepositoryIntegration").mockImplementation(
        async () =>
          active
            ? integrationState()
            : {
                ...integrationState(),
                kind: "none",
                owned: false,
                sessionId: null,
                canContinue: false,
                mainline: null,
                empty: false,
                canSkip: false,
                dirty: false,
                message: null,
              },
      );
      const newId = "22222222-2222-4222-8222-222222222222";
      let recovery!: GitRepositoryOperation;
      vi.spyOn(runtimeApi, "gitRepositoryOperate").mockImplementation(
        async (_workspace, action) => {
          recovery = { ...operation(action), id: newId };
          return recovery;
        },
      );
      vi.mocked(runtimeApi.gitRepositoryOperation).mockImplementation(
        async (_workspace, id) => {
          expect(id).toBe(newId);
          active = false;
          const complete = {
            ...recovery,
            state: "succeeded" as const,
            finishedAt: "2026-09-05T00:00:03Z",
          };
          history = [
            complete,
            {
              ...waitingMerge(),
              state: abort ? "cancelled" : "succeeded",
              finishedAt: "2026-09-05T00:00:03Z",
            },
          ];
          return complete;
        },
      );
      const { client } = view("integration");
      fireEvent.click(
        await screen.findByRole("button", {
          name: abort ? "Abort merge" : "Continue and commit merge",
        }),
      );
      await confirm();
      await waitFor(() =>
        expect(
          client.getQueryData<GitRepositoryOperation>(
            cachedOperationKey(mergeId),
          )?.state,
        ).toBe(abort ? "cancelled" : "succeeded"),
      );
      fireEvent.click(screen.getByText("Operations in this Runtime session"));
      fireEvent.click(
        await screen.findByRole("button", {
          name: new RegExp(
            `Start merge · ${abort ? "Cancelled" : "Completed"}`,
          ),
        }),
      );
      const region = screen.getByRole("region", { name: "Operation status" });
      await waitFor(() =>
        expect(region.textContent).toContain(abort ? "Cancelled" : "Completed"),
      );
      // A stale list must not restore this original merge's waiting state.
      history = [waitingMerge()];
      await act(async () => {
        await client.invalidateQueries({
          queryKey: ["git-repository-operations", "workspace-one"],
        });
      });
      expect(
        client.getQueryData<GitRepositoryOperation>(cachedOperationKey(mergeId))
          ?.state,
      ).toBe(abort ? "cancelled" : "succeeded");
      expect(region.textContent).not.toContain("Awaiting resolution");
    },
  );

  it.each(["queued", "running", "awaitingResolution"] as const)(
    "ignores a late %s poll after the same operation was confirmed complete",
    async (lateState) => {
      let history: GitRepositoryOperation[] = [
        {
          ...waitingMerge(),
          state: "running" as GitRepositoryOperation["state"],
          finishedAt: null,
        },
      ];
      let completePoll!: (result: GitRepositoryOperation) => void;
      vi.mocked(runtimeApi.gitRepositoryOperations).mockImplementation(
        async () => history,
      );
      vi.mocked(runtimeApi.gitRepositoryOperation).mockImplementation(
        () =>
          new Promise((resolve) => {
            completePoll = resolve;
          }),
      );
      const { client } = view();
      const region = await screen.findByRole("region", {
        name: "Operation status",
      });
      await waitFor(() => expect(completePoll).toBeTypeOf("function"));
      history = [
        {
          ...waitingMerge(),
          state: "succeeded",
          finishedAt: "2026-09-05T00:00:03Z",
        },
      ];
      await act(async () => {
        await client.invalidateQueries({
          queryKey: ["git-repository-operations", "workspace-one"],
        });
      });
      await waitFor(() => expect(region.textContent).toContain("Completed"));
      await act(async () =>
        completePoll({ ...waitingMerge(), state: lateState }),
      );
      await waitFor(() =>
        expect(
          client.getQueryData<GitRepositoryOperation>(
            cachedOperationKey(mergeId),
          )?.state,
        ).toBe("succeeded"),
      );
      expect(region.textContent).toContain("Completed");
      expect(region.textContent).not.toContain("Awaiting resolution");
    },
  );
});
