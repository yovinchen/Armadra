import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  GitIntegrationSnapshot,
  GitRebaseTodoPreview,
} from "@armadra/shared";
import { RebaseTodo, type RebaseTodoProps } from "./RebaseTodo";

vi.mock("../../app/preferences-store", () => ({
  useT: () => (key: string) => key,
}));
afterEach(cleanup);

const onto = "a".repeat(40);
const base = "b".repeat(40);
const first = "c".repeat(40);
const second = "d".repeat(40);
const head = "e".repeat(40);

function commit(oid: string, subject: string, parents: string[] = []) {
  return {
    oid,
    parents,
    subject,
    authorName: "Author",
    authorEmail: "author@example.test",
    authorTime: "2026-01-01T00:00:00Z",
    committerTime: "2026-01-01T00:00:00Z",
    refs: [],
  };
}

function preview(
  overrides: Partial<GitRebaseTodoPreview> = {},
): GitRebaseTodoPreview {
  return {
    onto,
    base,
    head: { headOid: head, branch: "main" },
    commits: [commit(first, "First change"), commit(second, "Second change")],
    hasMerges: false,
    ...overrides,
  };
}

const state: GitIntegrationSnapshot = {
  repositoryId: "repo",
  repositoryPath: "/project",
  head: { headOid: head, branch: "main" },
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

function setup(overrides: Partial<RebaseTodoProps> = {}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const props: RebaseTodoProps = {
    workspaceId: "workspace",
    repositoryKey: "repo:/project",
    onto,
    state,
    disabled: false,
    loadPreview: vi.fn(async () => preview()),
    request: vi.fn(),
    ...overrides,
  };
  render(<RebaseTodo {...props} />, {
    wrapper: ({ children }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  });
  return props;
}

it("sends the reviewed order and commands, covering every replayed commit", async () => {
  const props = setup();
  await screen.findByText("First change");
  // Move the second commit to the front, then drop the first one.
  fireEvent.click(
    screen.getAllByRole("button", { name: "gitRepo.rebaseTodoUp" })[1]!,
  );
  const commands = screen.getAllByLabelText("gitRepo.rebaseTodoCommand");
  fireEvent.change(commands[1]!, { target: { value: "drop" } });
  fireEvent.click(
    screen.getByRole("button", { name: "gitRepo.startInteractiveRebase" }),
  );
  expect(props.request).toHaveBeenCalledExactlyOnceWith(
    {
      kind: "startInteractiveRebase",
      onto,
      // The dropped commit is still listed: omitting it is never how a commit
      // gets dropped.
      todo: [
        { oid: second, command: "pick" },
        { oid: first, command: "drop" },
      ],
      expectedStateToken: state.stateToken,
    },
    state.head,
  );
});

it("refuses a squash with nothing kept before it and a todo that drops everything", async () => {
  const props = setup();
  await screen.findByText("First change");
  const commands = screen.getAllByLabelText("gitRepo.rebaseTodoCommand");
  fireEvent.change(commands[0]!, { target: { value: "squash" } });
  const run = screen.getByRole("button", {
    name: "gitRepo.startInteractiveRebase",
  });
  expect(screen.getByText("gitRepo.rebaseTodoSquashNeedsKept")).toBeTruthy();
  expect((run as HTMLButtonElement).disabled).toBe(true);

  fireEvent.change(commands[0]!, { target: { value: "drop" } });
  fireEvent.change(commands[1]!, { target: { value: "drop" } });
  expect((run as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(run);
  expect(props.request).not.toHaveBeenCalled();
});

it("carries a reword's message and refuses to run without one", async () => {
  const props = setup();
  await screen.findByText("First change");
  const commands = screen.getAllByLabelText("gitRepo.rebaseTodoCommand");
  fireEvent.change(commands[0]!, { target: { value: "reword" } });
  // 默认填上原来的标题：改写信息的起点是它现在说的话。
  const message = screen.getByLabelText(
    "gitRepo.rebaseTodoMessage",
  ) as HTMLTextAreaElement;
  expect(message.value).toBe("First change");

  const run = screen.getByRole("button", {
    name: "gitRepo.startInteractiveRebase",
  });
  fireEvent.change(message, { target: { value: "   " } });
  expect(screen.getByText("gitRepo.rebaseTodoRewordNeedsMessage")).toBeTruthy();
  expect((run as HTMLButtonElement).disabled).toBe(true);

  fireEvent.change(message, { target: { value: "改写后的标题" } });
  fireEvent.click(run);
  expect(props.request).toHaveBeenCalledExactlyOnceWith(
    {
      kind: "startInteractiveRebase",
      onto,
      todo: [
        { oid: first, command: "reword", message: "改写后的标题" },
        { oid: second, command: "pick" },
      ],
      expectedStateToken: state.stateToken,
    },
    state.head,
  );
});

it("drops a message when the verb stops being a reword", async () => {
  const props = setup();
  await screen.findByText("First change");
  const commands = screen.getAllByLabelText("gitRepo.rebaseTodoCommand");
  fireEvent.change(commands[0]!, { target: { value: "reword" } });
  fireEvent.change(screen.getByLabelText("gitRepo.rebaseTodoMessage"), {
    target: { value: "never used" },
  });
  // 换成 fixup：那条信息永远不会被用上，留着它只会让服务端拒绝整份 todo。
  fireEvent.change(commands[0]!, { target: { value: "pick" } });
  fireEvent.change(commands[1]!, { target: { value: "fixup" } });
  fireEvent.click(
    screen.getByRole("button", { name: "gitRepo.startInteractiveRebase" }),
  );
  expect(props.request).toHaveBeenCalledExactlyOnceWith(
    {
      kind: "startInteractiveRebase",
      onto,
      todo: [
        { oid: first, command: "pick" },
        { oid: second, command: "fixup" },
      ],
      expectedStateToken: state.stateToken,
    },
    state.head,
  );
});

it("refuses a fixup with nothing kept before it, exactly as a squash", async () => {
  const props = setup();
  await screen.findByText("First change");
  const commands = screen.getAllByLabelText("gitRepo.rebaseTodoCommand");
  fireEvent.change(commands[0]!, { target: { value: "fixup" } });
  const run = screen.getByRole("button", {
    name: "gitRepo.startInteractiveRebase",
  });
  expect(screen.getByText("gitRepo.rebaseTodoSquashNeedsKept")).toBeTruthy();
  expect((run as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(run);
  expect(props.request).not.toHaveBeenCalled();
});

it("says that an edit stops the replay rather than finishing it", async () => {
  setup();
  await screen.findByText("First change");
  const commands = screen.getAllByLabelText("gitRepo.rebaseTodoCommand");
  fireEvent.change(commands[0]!, { target: { value: "edit" } });
  expect(screen.getByText("gitRepo.rebaseTodoEditStops")).toBeTruthy();
  expect(
    (
      screen.getByRole("button", {
        name: "gitRepo.startInteractiveRebase",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(false);
});

it("does not offer the editor for a range that contains a merge commit", async () => {
  const props = setup({
    loadPreview: vi.fn(async () =>
      preview({
        commits: [commit(first, "A merge", [second, head])],
        hasMerges: true,
      }),
    ),
  });
  await screen.findByText("gitRepo.rebaseTodoMerges");
  const run = screen.getByRole("button", {
    name: "gitRepo.startInteractiveRebase",
  });
  expect((run as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(run);
  expect(props.request).not.toHaveBeenCalled();
});
