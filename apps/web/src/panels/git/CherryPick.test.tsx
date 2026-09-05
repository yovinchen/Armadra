import { afterEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  GitCherryPickPreview,
  GitIntegrationSnapshot,
} from "@armadra/shared";
import { CherryPick, type CherryPickProps } from "./CherryPick";
vi.mock("../../app/preferences-store", () => ({
  useT: () => (key: string) => key,
}));
afterEach(cleanup);
const a = "a".repeat(40),
  b = "b".repeat(40),
  c = "c".repeat(40);
const state: GitIntegrationSnapshot = {
  repositoryId: "repo",
  repositoryPath: "/repo",
  head: { headOid: c, branch: "main" },
  stateToken: "d".repeat(64),
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
function preview(
  oid = a,
  mainline: number | null = null,
): GitCherryPickPreview {
  return {
    targetOid: oid,
    parents: [c],
    subject: `Commit ${oid.slice(0, 1)}`,
    authorName: "Source",
    authorEmail: "source@example.invalid",
    authorTime: "2026-09-05T00:00:00Z",
    mainline,
    patch: "+source change",
  };
}
function setup(overrides: Partial<CherryPickProps> = {}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const props: CherryPickProps = {
    workspaceId: "workspace",
    repositoryKey: "repo:/repo",
    state,
    disabled: false,
    canRequest: () => true,
    loadPreview: vi.fn(async (oid, mainline) => preview(oid, mainline)),
    request: vi.fn(),
    ...overrides,
  };
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const rendered = render(<CherryPick {...props} />, { wrapper });
  return {
    ...rendered,
    props,
    rerenderProps: (next: Partial<CherryPickProps>) =>
      rendered.rerender(<CherryPick {...props} {...next} />),
  };
}
async function enter(oid = a) {
  fireEvent.change(screen.getByLabelText("gitIntegration.commitOid"), {
    target: { value: oid },
  });
}

describe("cherry-pick review", () => {
  it("requires a reviewed full OID and submits the explicit origin option with observed repository state", async () => {
    const { props } = setup();
    await enter(a.toUpperCase());
    await screen.findByText("+source change");
    expect(props.request).not.toHaveBeenCalled();
    fireEvent.click(screen.getByLabelText("gitIntegration.recordOrigin"));
    fireEvent.click(
      screen.getByRole("button", { name: "gitRepo.startCherryPick" }),
    );
    expect(props.request).toHaveBeenCalledExactlyOnceWith(
      {
        kind: "startCherryPick",
        targetOid: a,
        mainline: null,
        recordOrigin: true,
        expectedStateToken: state.stateToken,
      },
      state.head,
    );
  });
  it("requires an actual merge-parent selection and its corresponding patch before starting", async () => {
    const loadPreview = vi.fn(async (oid: string, mainline: number | null) => ({
      ...preview(oid, mainline),
      parents: [b, c],
      patch: mainline === null ? null : `+parent ${mainline}`,
    }));
    const { props } = setup({ loadPreview });
    await enter();
    await screen.findByLabelText("gitIntegration.mainline");
    fireEvent.click(
      screen.getByRole("button", { name: "gitRepo.startCherryPick" }),
    );
    expect(props.request).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("gitIntegration.mainline"), {
      target: { value: "2" },
    });
    await screen.findByText("+parent 2");
    fireEvent.click(
      screen.getByRole("button", { name: "gitRepo.startCherryPick" }),
    );
    expect(props.request).toHaveBeenCalledExactlyOnceWith(
      {
        kind: "startCherryPick",
        targetOid: a,
        mainline: 2,
        recordOrigin: false,
        expectedStateToken: state.stateToken,
      },
      state.head,
    );
    expect(loadPreview).toHaveBeenCalledWith(a, 2, expect.any(AbortSignal));
  });
  it("does not reuse a previous mainline patch while the next selection loads", async () => {
    let complete!: (value: GitCherryPickPreview) => void;
    const loadPreview = vi.fn((oid: string, mainline: number | null) =>
      mainline === 2
        ? new Promise<GitCherryPickPreview>((resolve) => {
            complete = resolve;
          })
        : Promise.resolve({
            ...preview(oid, mainline),
            parents: [b, c],
            patch: mainline === null ? null : "+parent 1",
          }),
    );
    const { props } = setup({ loadPreview });
    await enter();
    const select = await screen.findByLabelText("gitIntegration.mainline");
    fireEvent.change(select, { target: { value: "1" } });
    await screen.findByText("+parent 1");
    fireEvent.change(select, { target: { value: "2" } });
    fireEvent.click(
      screen.getByRole("button", { name: "gitRepo.startCherryPick" }),
    );
    expect(props.request).not.toHaveBeenCalled();
    await waitFor(() => expect(complete).toBeTypeOf("function"));
    await act(async () =>
      complete({ ...preview(a, 2), parents: [b, c], patch: "+parent 2" }),
    );
    await screen.findByText("+parent 2");
    fireEvent.click(
      screen.getByRole("button", { name: "gitRepo.startCherryPick" }),
    );
    expect(props.request).toHaveBeenCalledExactlyOnceWith(
      {
        kind: "startCherryPick",
        targetOid: a,
        mainline: 2,
        recordOrigin: false,
        expectedStateToken: state.stateToken,
      },
      state.head,
    );
  });
  it("rejects mismatched preview objects and never automatically retries", async () => {
    const loadPreview = vi.fn(async () => preview(b));
    const { props } = setup({ loadPreview });
    await enter();
    await screen.findByText("gitIntegration.changed");
    fireEvent.click(
      screen.getByRole("button", { name: "gitRepo.startCherryPick" }),
    );
    expect(props.request).not.toHaveBeenCalled();
    expect(loadPreview).toHaveBeenCalledTimes(1);
  });
  it("ignores a late preview after switching OIDs and rechecks the live repository gate", async () => {
    let complete!: (value: GitCherryPickPreview) => void;
    let allowed = true;
    const { props } = setup({
      canRequest: () => allowed,
      loadPreview: (oid, mainline) =>
        oid === a
          ? new Promise((resolve) => {
              complete = resolve;
            })
          : Promise.resolve(preview(oid, mainline)),
    });
    await enter();
    await waitFor(() => expect(complete).toBeTypeOf("function"));
    await enter(b);
    await screen.findByText("Commit b");
    await act(async () => complete(preview(a)));
    expect(screen.queryByText("Commit a")).toBeNull();
    allowed = false;
    fireEvent.click(
      screen.getByRole("button", { name: "gitRepo.startCherryPick" }),
    );
    expect(props.request).not.toHaveBeenCalled();
    allowed = true;
    fireEvent.click(
      screen.getByRole("button", { name: "gitRepo.startCherryPick" }),
    );
    expect(props.request).toHaveBeenCalledExactlyOnceWith(
      {
        kind: "startCherryPick",
        targetOid: b,
        mainline: null,
        recordOrigin: false,
        expectedStateToken: state.stateToken,
      },
      state.head,
    );
  });
});
