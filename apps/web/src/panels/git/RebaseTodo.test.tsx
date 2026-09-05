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
