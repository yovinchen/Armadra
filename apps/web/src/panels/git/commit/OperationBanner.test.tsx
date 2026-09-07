import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { GitIntegrationSnapshot } from "@armadra/shared";
import { OperationBanner } from "./OperationBanner";

vi.mock("../../../app/preferences-store", () => ({
  useT: () => (key: string) => key,
}));
afterEach(cleanup);

const sessionId = "11111111-1111-4111-8111-111111111111";
const head = { headOid: "a".repeat(40), branch: "main" };

function state(
  overrides: Partial<GitIntegrationSnapshot> = {},
): GitIntegrationSnapshot {
  return {
    repositoryId: "repo",
    repositoryPath: "/project",
    head,
    stateToken: "d".repeat(64),
    kind: "merge",
    owned: true,
    sessionId,
    originalHead: null,
    originalBranch: "main",
    targetOid: "b".repeat(40),
    message: "Merge branch feature",
    dirty: true,
    canContinue: true,
    mainline: null,
    empty: false,
    canSkip: false,
    conflicts: [],
    ...overrides,
  };
}

function view(
  overrides: Partial<GitIntegrationSnapshot> = {},
  options: { busy?: boolean } = {},
) {
  const onResume = vi.fn();
  render(
    <OperationBanner
      entries={[
        { repositoryPath: ".", name: "project", state: state(overrides) },
      ]}
      busy={options.busy ?? false}
      showRepositories={false}
      onResume={onResume}
    />,
  );
  return onResume;
}

describe("operation banner", () => {
  it("shows nothing when no repository is mid-integration", () => {
    const { container } = render(
      <OperationBanner
        entries={[]}
        busy={false}
        showRepositories={false}
        onResume={vi.fn()}
      />,
    );
    expect(container.textContent).toBe("");
  });

  it("continues with the session and state token it displayed", () => {
    const onResume = view();
    fireEvent.click(
      screen.getByRole("button", { name: "gitIntegration.continueMerge" }),
    );
    expect(onResume).toHaveBeenCalledWith(".", {
      action: {
        kind: "continueIntegration",
        sessionId,
        expectedStateToken: "d".repeat(64),
      },
      expected: head,
    });
  });

  it("aborts even when the service says continue is not possible", () => {
    const onResume = view({ canContinue: false });
    expect(
      (
        screen.getByRole("button", {
          name: "gitIntegration.continueMerge",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    fireEvent.click(
      screen.getByRole("button", { name: "gitIntegration.abortMerge" }),
    );
    expect(onResume.mock.calls[0]![1].action.kind).toBe("abortIntegration");
  });

  it("offers skip during a rebase and calls it out as a discard", () => {
    const onResume = view({ kind: "rebase", canSkip: true });
    fireEvent.click(
      screen.getByRole("button", { name: "gitRepo.skipReplayedCommit" }),
    );
    expect(onResume.mock.calls[0]![1].action.kind).toBe("skipIntegration");
    expect(screen.getByText("gitRepo.skipReplayedCommitHint")).toBeTruthy();
  });

  it("does not offer skip during a merge", () => {
    view();
    expect(
      screen.queryByRole("button", { name: "gitRepo.skipIntegration" }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "gitRepo.skipReplayedCommit" }),
    ).toBeNull();
  });

  it("refuses to act on a session this application does not own", () => {
    const onResume = view({ owned: false });
    expect(
      screen.queryByRole("button", { name: "gitIntegration.continueMerge" }),
    ).toBeNull();
    expect(screen.getByText("gitIntegration.external")).toBeTruthy();
    expect(onResume).not.toHaveBeenCalled();
  });

  it("sends nothing while another write is in flight", () => {
    const onResume = view({}, { busy: true });
    fireEvent.click(
      screen.getByRole("button", { name: "gitIntegration.abortMerge" }),
    );
    expect(onResume).not.toHaveBeenCalled();
  });
});
