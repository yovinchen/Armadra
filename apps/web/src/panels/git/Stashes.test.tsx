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
import type { GitStashDetail, GitStashSnapshot } from "@armadra/shared";
import { Stashes, type StashesProps } from "./Stashes";

vi.mock("../../app/preferences-store", () => ({
  useT: () => (key: string) => key,
}));
afterEach(cleanup);
const oid = "a".repeat(40);
const otherOid = "b".repeat(40);
const head = { headOid: "c".repeat(40), branch: "feature/observed" };
function snapshot(): GitStashSnapshot {
  return {
    repositoryId: "repo",
    repositoryPath: "/project",
    head,
    stateToken: "d".repeat(64),
    dirty: true,
    hasConflicts: false,
    stashes: [
      {
        oid,
        selector: "stash@{0}",
        subject: "Saved work",
        authorName: "Author",
        authorTime: "2026-09-05T00:00:00Z",
      },
    ],
  };
}
function detail(selected = oid): GitStashDetail {
  return {
    oid: selected,
    parents: [head.headOid, "e".repeat(40)],
    patch: "+worktree",
    stagedPatch: "+index",
    untrackedPatch: "+new file",
  };
}
function setup(overrides: Partial<StashesProps> = {}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const props: StashesProps = {
    workspaceId: "workspace",
    repositoryKey: "repo:/project",
    busy: false,
    loadSnapshot: vi.fn(async () => snapshot()),
    loadDetail: vi.fn(async (oid) => detail(oid)),
    request: vi.fn(),
    ...overrides,
  };
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const rendered = render(<Stashes {...props} />, { wrapper });
  return {
    ...rendered,
    props,
    client,
    rerenderProps: (next: Partial<StashesProps>) =>
      rendered.rerender(<Stashes {...props} {...next} />),
  };
}
async function viewDetail() {
  fireEvent.click(await screen.findByRole("button", { name: "gitStash.view" }));
  await screen.findByText("+worktree");
}

describe("stash actions", () => {
  it("creates only after an explicit click and binds all options to the observed head and content token", async () => {
    const { props } = setup();
    await screen.findByText("Saved work");
    expect(props.request).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("gitStash.message"), {
      target: { value: "保存工作" },
    });
    fireEvent.click(screen.getByLabelText("gitStash.includeUntracked"));
    fireEvent.click(
      screen.getByRole("button", { name: "gitRepo.createStash" }),
    );
    expect(props.request).toHaveBeenCalledExactlyOnceWith(
      {
        kind: "createStash",
        message: "保存工作",
        includeUntracked: true,
        expectedStateToken: snapshot().stateToken,
      },
      head,
    );
  });

  it("shows all three snapshots and carries the fixed object and index option into confirmation", async () => {
    const { props } = setup();
    await viewDetail();
    expect(screen.getByText("+index")).toBeTruthy();
    expect(screen.getByText("+new file")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("gitStash.reinstateIndex"));
    fireEvent.click(screen.getByRole("button", { name: "gitRepo.popStash" }));
    expect(props.request).toHaveBeenCalledExactlyOnceWith(
      {
        kind: "popStash",
        oid,
        reinstateIndex: true,
        expectedStateToken: snapshot().stateToken,
      },
      head,
    );
  });

  it("prevents apply or save during conflicts while still allowing explicit reviewed drop", async () => {
    const state = { ...snapshot(), hasConflicts: true };
    const { props } = setup({ loadSnapshot: async () => state });
    await viewDetail();
    fireEvent.click(screen.getByRole("button", { name: "gitRepo.popStash" }));
    fireEvent.click(
      screen.getByRole("button", { name: "gitRepo.createStash" }),
    );
    expect(props.request).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "gitRepo.dropStash" }));
    expect(props.request).toHaveBeenCalledExactlyOnceWith(
      { kind: "dropStash", oid, expectedStateToken: state.stateToken },
      head,
    );
  });

  it("does not act while details load, after a mismatched response, or while another operation runs", async () => {
    let complete!: (value: GitStashDetail) => void;
    const { props, rerenderProps } = setup({
      loadDetail: () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    });
    fireEvent.click(
      await screen.findByRole("button", { name: "gitStash.view" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "gitRepo.dropStash" }));
    expect(props.request).not.toHaveBeenCalled();
    await act(async () => complete(detail(otherOid)));
    await screen.findByText("gitStash.changed");
    fireEvent.click(screen.getByRole("button", { name: "gitRepo.dropStash" }));
    expect(props.request).not.toHaveBeenCalled();
    rerenderProps({ busy: true });
    fireEvent.click(
      screen.getByRole("button", { name: "gitRepo.createStash" }),
    );
    expect(props.request).not.toHaveBeenCalled();
  });

  it("does not keep a removed selection after refresh or carry it across workspace changes", async () => {
    let state = snapshot();
    const { props, rerenderProps } = setup({ loadSnapshot: async () => state });
    await viewDetail();
    state = { ...state, stashes: [] };
    fireEvent.click(screen.getByRole("button", { name: "gitRepo.refresh" }));
    await screen.findByText("gitStash.empty");
    expect(
      screen.queryByRole("button", { name: "gitRepo.dropStash" }),
    ).toBeNull();
    rerenderProps({
      workspaceId: "other",
      repositoryKey: "repo:/elsewhere",
      loadSnapshot: async () => ({
        ...snapshot(),
        repositoryPath: "/elsewhere",
      }),
    });
    await screen.findByText("Saved work");
    expect(
      screen.queryByRole("button", { name: "gitRepo.dropStash" }),
    ).toBeNull();
    expect(props.request).not.toHaveBeenCalled();
  });

  it("rejects a snapshot belonging to another repository and does not retry it automatically", async () => {
    const loadSnapshot = vi.fn(async () => ({
      ...snapshot(),
      repositoryId: "foreign",
    }));
    const { props } = setup({ loadSnapshot });
    await screen.findByText("gitStash.changed");
    fireEvent.click(
      screen.getByRole("button", { name: "gitRepo.createStash" }),
    );
    expect(props.request).not.toHaveBeenCalled();
    expect(loadSnapshot).toHaveBeenCalledTimes(1);
  });

  it("never applies a late detail for an older selection", async () => {
    let complete!: (value: GitStashDetail) => void;
    const state = snapshot();
    state.stashes.push({
      ...state.stashes[0]!,
      oid: otherOid,
      selector: "stash@{1}",
      subject: "Other work",
    });
    const { props } = setup({
      loadSnapshot: async () => state,
      loadDetail: (selected) =>
        selected === oid
          ? new Promise((resolve) => {
              complete = resolve;
            })
          : Promise.resolve(detail(otherOid)),
    });
    const buttons = await screen.findAllByRole("button", {
      name: "gitStash.view",
    });
    fireEvent.click(buttons[0]!);
    await waitFor(() => expect(complete).toBeTypeOf("function"));
    fireEvent.click(buttons[1]!);
    await screen.findByText("+worktree");
    await act(async () => complete(detail(oid)));
    fireEvent.click(screen.getByRole("button", { name: "gitRepo.applyStash" }));
    expect(props.request).toHaveBeenCalledExactlyOnceWith(
      {
        kind: "applyStash",
        oid: otherOid,
        reinstateIndex: false,
        expectedStateToken: state.stateToken,
      },
      head,
    );
  });
});
