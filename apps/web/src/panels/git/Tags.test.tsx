import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { GitTagSnapshot } from "@armadra/shared";
import { Tags, type TagsProps } from "./Tags";

vi.mock("../../app/preferences-store", () => ({
  useT: () => (key: string) => key,
}));
afterEach(cleanup);

const commit = "a".repeat(40);
const tagObject = "b".repeat(40);
const other = "c".repeat(40);

function snapshot(): GitTagSnapshot {
  return {
    repositoryId: "repo",
    repositoryPath: "/project",
    head: { headOid: other, branch: "main" },
    observedAt: "now",
    tags: [
      {
        name: "v1.0",
        fullRef: "refs/tags/v1.0",
        // An annotated tag's own object differs from the commit it names.
        oid: tagObject,
        targetOid: commit,
        annotated: true,
        subject: "First release",
        taggerName: "Tester",
        taggerTime: "2026-01-01T00:00:00Z",
      },
    ],
  };
}

function setup(overrides: Partial<TagsProps> = {}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const props: TagsProps = {
    workspaceId: "workspace",
    repositoryKey: "repo:/project",
    remotes: ["origin"],
    busy: false,
    loadTags: vi.fn(async () => snapshot()),
    request: vi.fn(),
    ...overrides,
  };
  render(<Tags {...props} />, {
    wrapper: ({ children }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  });
  return props;
}

it("deletes and pushes a tag by its own object, not the commit behind it", async () => {
  const props = setup();
  await screen.findByText("v1.0");
  fireEvent.click(screen.getByRole("button", { name: "gitRepo.deleteTag" }));
  expect(props.request).toHaveBeenCalledExactlyOnceWith({
    kind: "deleteTag",
    name: "v1.0",
    expectedOid: tagObject,
  });
  vi.mocked(props.request).mockClear();
  fireEvent.click(screen.getByRole("button", { name: "gitRepo.pushTag" }));
  expect(props.request).toHaveBeenCalledExactlyOnceWith({
    kind: "pushTag",
    remote: "origin",
    name: "v1.0",
    expectedOid: tagObject,
  });
});

it("creates a lightweight tag at HEAD and an annotated one only with a message", async () => {
  const props = setup();
  await screen.findByText("v1.0");
  fireEvent.change(screen.getByLabelText("gitRepo.tagName"), {
    target: { value: "v2.0" },
  });
  fireEvent.click(screen.getByRole("button", { name: "gitRepo.createTag" }));
  // A blank target means the observed HEAD, never a guessed ref name.
  expect(props.request).toHaveBeenCalledExactlyOnceWith({
    kind: "createTag",
    name: "v2.0",
    targetOid: other,
    message: null,
  });

  vi.mocked(props.request).mockClear();
  fireEvent.click(
    screen.getByRole("checkbox", { name: "gitRepo.tagAnnotated" }),
  );
  const create = screen.getByRole("button", { name: "gitRepo.createTag" });
  expect((create as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(screen.getByLabelText("gitRepo.tagMessage"), {
    target: { value: "Second release" },
  });
  fireEvent.change(screen.getByLabelText("gitRepo.tagTarget"), {
    target: { value: commit },
  });
  fireEvent.click(create);
  expect(props.request).toHaveBeenCalledExactlyOnceWith({
    kind: "createTag",
    name: "v2.0",
    targetOid: commit,
    message: "Second release",
  });
});

it("cannot push while no remote is configured", async () => {
  const props = setup({ remotes: [] });
  await screen.findByText("v1.0");
  const push = screen.getByRole("button", { name: "gitRepo.pushTag" });
  expect((push as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(push);
  expect(props.request).not.toHaveBeenCalled();
});
