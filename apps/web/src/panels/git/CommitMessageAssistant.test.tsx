import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { GitMessageDraft, GitMessageSource } from "@armadra/shared";
import { usePreferencesStore } from "../../app/preferences-store";
import {
  CommitMessageAssistant,
  type CommitMessageAssistantProps,
} from "./CommitMessageAssistant";
const source: GitMessageSource = {
  expectedHead: "a".repeat(40),
  indexDigest: "b".repeat(64),
  sourceDigest: "c".repeat(64),
  includedFiles: ["src/app.ts"],
  excludedFiles: [".env"],
  truncated: true,
  redacted: true,
};
const draft: GitMessageDraft = {
  ...source,
  provider: "claude-bare",
  message: "Improve workspace rendering",
};
const clients: QueryClient[] = [];
function view(overrides: Partial<CommitMessageAssistantProps> = {}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  clients.push(client);
  const props: CommitMessageAssistantProps = {
    workspaceId: "workspace",
    message: "",
    onFill: vi.fn(),
    providers: vi.fn(async () => [
      { id: "claude-bare", label: "Claude API", available: true, reason: null },
    ]),
    source: vi.fn(async () => source),
    generate: vi.fn(async () => draft),
    ...overrides,
  };
  const ui = (next = props) => (
    <QueryClientProvider client={client}>
      <CommitMessageAssistant {...next} />
    </QueryClientProvider>
  );
  return { ...render(ui()), props, ui };
}
beforeEach(() => usePreferencesStore.setState({ locale: "en" }));
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
});
async function generate() {
  const button = await screen.findByRole("button", { name: "Generate draft" });
  await waitFor(() =>
    expect((button as HTMLButtonElement).disabled).toBe(false),
  );
  fireEvent.click(button);
}
describe("AI commit-message preview", () => {
  it("never generates automatically and only fills after a separate explicit click and fresh source check", async () => {
    const { props } = view();
    await screen.findByText(/Included files/, { selector: "summary" });
    expect(props.generate).not.toHaveBeenCalled();
    await generate();
    await screen.findByRole("textbox", { name: "Draft preview" });
    expect(props.onFill).not.toHaveBeenCalled();
    expect(props.generate).toHaveBeenCalledWith("workspace", {
      provider: "claude-bare",
      expectedHead: source.expectedHead,
      indexDigest: source.indexDigest,
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Fill commit message" }),
    );
    await waitFor(() =>
      expect(props.onFill).toHaveBeenCalledWith(draft.message),
    );
    expect(props.source).toHaveBeenCalledTimes(3);
    expect(screen.getByText(/Input was truncated/)).toBeTruthy();
    expect(screen.getByText(/Detected sensitive lines/)).toBeTruthy();
  });
  it("does not overwrite a manual edit made while the model response was pending", async () => {
    let finish!: (value: GitMessageDraft) => void;
    const generator = vi.fn(
      () =>
        new Promise<GitMessageDraft>((resolve) => {
          finish = resolve;
        }),
    );
    const rendered = view({ generate: generator });
    await generate();
    await waitFor(() => expect(generator).toHaveBeenCalledTimes(1));
    rendered.rerender(
      rendered.ui({ ...rendered.props, message: "My manually written commit" }),
    );
    await act(async () => finish(draft));
    expect(
      (
        (await screen.findByRole("button", {
          name: "Fill commit message",
        })) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(rendered.props.onFill).not.toHaveBeenCalled();
    expect(screen.getByText(/was edited manually/)).toBeTruthy();
  });
  it("checks manual edits again after the async Fill baseline check", async () => {
    let finish!: (value: GitMessageSource) => void;
    let reads = 0;
    const load = vi.fn(async () => {
      reads++;
      return reads === 3
        ? new Promise<GitMessageSource>((resolve) => {
            finish = resolve;
          })
        : source;
    });
    const rendered = view({ source: load });
    await generate();
    fireEvent.click(
      await screen.findByRole("button", { name: "Fill commit message" }),
    );
    await waitFor(() => expect(load).toHaveBeenCalledTimes(3));
    rendered.rerender(
      rendered.ui({ ...rendered.props, message: "Keep this manual draft" }),
    );
    await act(async () => finish(source));
    expect(rendered.props.onFill).not.toHaveBeenCalled();
    expect(screen.getAllByText(/was edited manually/).length).toBeGreaterThan(
      0,
    );
  });
  it("refuses Fill when the index changed and does not retry generation", async () => {
    let reads = 0;
    const { props } = view({
      source: vi.fn(async () =>
        ++reads === 3
          ? {
              ...source,
              indexDigest: "d".repeat(64),
              sourceDigest: "e".repeat(64),
            }
          : source,
      ),
    });
    await generate();
    fireEvent.click(
      await screen.findByRole("button", { name: "Fill commit message" }),
    );
    await screen.findByText(
      "HEAD or staged content changed. Generate a new draft.",
    );
    expect(props.onFill).not.toHaveBeenCalled();
    expect(props.generate).toHaveBeenCalledTimes(1);
  });
  it("discards late results from another workspace", async () => {
    let finish!: (value: GitMessageDraft) => void;
    const generator = vi.fn(
      () =>
        new Promise<GitMessageDraft>((resolve) => {
          finish = resolve;
        }),
    );
    const rendered = view({ generate: generator });
    await generate();
    await waitFor(() => expect(generator).toHaveBeenCalledTimes(1));
    rendered.rerender(rendered.ui({ ...rendered.props, workspaceId: "other" }));
    await act(async () => finish(draft));
    expect(screen.queryByRole("textbox", { name: "Draft preview" })).toBeNull();
    expect(rendered.props.onFill).not.toHaveBeenCalled();
  });
  it("shows missing API credentials without pretending subscription login is supported", async () => {
    const { props } = view({
      providers: vi.fn(async () => [
        {
          id: "claude-bare",
          label: "Claude API",
          available: false,
          reason: "missingCredentials",
        },
      ]),
    });
    await screen.findByText("The running service has no ANTHROPIC_API_KEY.");
    expect(
      (
        screen.getByRole("button", {
          name: "Generate draft",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(
      screen.getByText(/does not use the Claude subscription login/),
    ).toBeTruthy();
    expect(props.generate).not.toHaveBeenCalled();
  });
});
