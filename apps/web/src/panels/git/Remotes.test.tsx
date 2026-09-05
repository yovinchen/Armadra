import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { GitRemoteRecord } from "@armadra/shared";
import { Remotes, redactRemoteUrl, type RemotesProps } from "./Remotes";

vi.mock("../../app/preferences-store", () => ({
  useT: () => (key: string) => key,
}));
afterEach(cleanup);

function record(overrides: Partial<GitRemoteRecord> = {}): GitRemoteRecord {
  return {
    name: "origin",
    fetchUrl: "https://[redacted]@example.invalid/team/repo.git",
    pushUrl: "https://[redacted]@example.invalid/team/repo.git",
    redacted: true,
    ...overrides,
  };
}

function setup(overrides: Partial<RemotesProps> = {}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const props: RemotesProps = {
    workspaceId: "workspace",
    repositoryKey: "repo:/project",
    busy: false,
    loadRemotes: vi.fn(async () => [record()]),
    request: vi.fn(),
    ...overrides,
  };
  render(<Remotes {...props} />, {
    wrapper: ({ children }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  });
  return props;
}

describe("remote credentials", () => {
  it("replaces userinfo for display without touching an scp-style address", () => {
    expect(redactRemoteUrl("https://user:secret@host/team/repo.git")).toBe(
      "https://[redacted]@host/team/repo.git",
    );
    expect(redactRemoteUrl("ssh://user:secret@host/repo.git")).toBe(
      "ssh://[redacted]@host/repo.git",
    );
    expect(redactRemoteUrl("https://host/team/repo.git")).toBe(
      "https://host/team/repo.git",
    );
    // `git@host:path` has no password to hide and stays readable.
    expect(redactRemoteUrl("git@host:team/repo.git")).toBe(
      "git@host:team/repo.git",
    );
  });

  it("never prefills the redacted URL back into the change field", async () => {
    const props = setup();
    await screen.findByText("https://[redacted]@example.invalid/team/repo.git");
    expect(screen.getByText("gitRepo.remoteRedacted")).toBeTruthy();
    const field = screen.getByLabelText(
      "gitRepo.remoteNewUrl",
    ) as HTMLInputElement;
    expect(field.value).toBe("");
    // Changing the URL is only possible by typing a complete new one.
    expect(
      (
        screen.getByRole("button", {
          name: "gitRepo.setRemoteUrl",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    fireEvent.change(field, {
      target: { value: "https://example.invalid/team/other.git" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "gitRepo.setRemoteUrl" }),
    );
    expect(props.request).toHaveBeenCalledExactlyOnceWith({
      kind: "setRemoteUrl",
      name: "origin",
      url: "https://example.invalid/team/other.git",
    });
  });
});

it("adds, renames and removes a remote by name", async () => {
  const props = setup();
  await screen.findByText("origin");
  fireEvent.change(screen.getByLabelText("gitRepo.remoteName"), {
    target: { value: "upstream" },
  });
  fireEvent.change(screen.getByLabelText("gitRepo.remoteUrl"), {
    target: { value: "https://example.invalid/team/upstream.git" },
  });
  fireEvent.click(screen.getByRole("button", { name: "gitRepo.addRemote" }));
  expect(props.request).toHaveBeenCalledExactlyOnceWith({
    kind: "addRemote",
    name: "upstream",
    url: "https://example.invalid/team/upstream.git",
  });

  vi.mocked(props.request).mockClear();
  const rename = screen.getByRole("button", { name: "gitRepo.renameRemote" });
  expect((rename as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(screen.getByLabelText("gitRepo.remoteNewName"), {
    target: { value: "published" },
  });
  fireEvent.click(rename);
  expect(props.request).toHaveBeenCalledExactlyOnceWith({
    kind: "renameRemote",
    name: "origin",
    newName: "published",
  });

  vi.mocked(props.request).mockClear();
  fireEvent.click(screen.getByRole("button", { name: "gitRepo.removeRemote" }));
  expect(props.request).toHaveBeenCalledExactlyOnceWith({
    kind: "removeRemote",
    name: "origin",
  });
});
