import { afterEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { GitBranchRecord, GitIntegrationSnapshot } from "@armadra/shared";
import { Integrations, type IntegrationsProps } from "./Integrations";

vi.mock("../../app/preferences-store", () => ({
  useT: () => (key: string) => key,
}));
afterEach(cleanup);
const a = "a".repeat(40),
  b = "b".repeat(40);
const sessionId = "11111111-1111-4111-8111-111111111111";
function snapshot(): GitIntegrationSnapshot {
  return {
    repositoryId: "repo",
    repositoryPath: "/project",
    head: { headOid: a, branch: "main" },
    stateToken: "c".repeat(64),
    kind: "none",
    owned: false,
    sessionId: null,
    originalHead: null,
    targetOid: null,
    message: null,
    dirty: false,
    canContinue: false,
    conflicts: [],
  };
}
const branch: GitBranchRecord = {
  name: "topic",
  fullRef: "refs/heads/topic",
  oid: b,
  remote: false,
  current: false,
  upstream: null,
  upstreamMissing: false,
  ahead: null,
  behind: null,
  symbolicTarget: null,
};
function active(): GitIntegrationSnapshot {
  return {
    ...snapshot(),
    kind: "merge",
    owned: true,
    sessionId,
    originalHead: a,
    targetOid: b,
    message: "Explicit merge",
    dirty: true,
    canContinue: true,
  };
}
function setup(overrides: Partial<IntegrationsProps> = {}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const props: IntegrationsProps = {
    workspaceId: "workspace",
    repositoryKey: "repo:/project",
    branches: [branch],
    busy: false,
    loadSnapshot: vi.fn(async () => snapshot()),
    request: vi.fn(),
    openFile: vi.fn(),
    ...overrides,
  };
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const rendered = render(<Integrations {...props} />, { wrapper });
  return {
    ...rendered,
    props,
    rerenderProps: (next: Partial<IntegrationsProps>) =>
      rendered.rerender(<Integrations {...props} {...next} />),
  };
}
describe("integration recovery", () => {
  it("starts only an explicitly selected immutable target using the current state", async () => {
    const { props } = setup();
    await screen.findByText("gitIntegration.none");
    expect(props.request).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("gitIntegration.target"), {
      target: { value: branch.fullRef },
    });
    fireEvent.change(screen.getByLabelText("gitIntegration.message"), {
      target: { value: "Merge topic" },
    });
    fireEvent.click(screen.getByRole("button", { name: "gitRepo.startMerge" }));
    expect(props.request).toHaveBeenCalledExactlyOnceWith(
      {
        kind: "startMerge",
        targetOid: b,
        message: "Merge topic",
        expectedStateToken: snapshot().stateToken,
      },
      snapshot().head,
    );
  });
  it("leaves a clean merge pending until explicit continue and binds the owner session", async () => {
    const state = active();
    const { props } = setup({ loadSnapshot: async () => state });
    await screen.findByText("gitIntegration.pending");
    expect(screen.getByText("Explicit merge")).toBeTruthy();
    expect(props.request).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole("button", { name: "gitRepo.continueIntegration" }),
    );
    expect(props.request).toHaveBeenCalledExactlyOnceWith(
      {
        kind: "continueIntegration",
        sessionId,
        expectedStateToken: state.stateToken,
      },
      state.head,
    );
  });
  it("opens the exact conflicted file without resolving or staging it automatically", async () => {
    const state = {
      ...active(),
      canContinue: false,
      conflicts: [
        {
          path: "src/冲突 file.ts",
          base: null,
          ours: {
            oid: a,
            mode: "100644" as const,
            size: 5,
            preview: "ours",
            binary: false,
            truncated: false,
          },
          theirs: {
            oid: b,
            mode: "100644" as const,
            size: 5,
            preview: "theirs",
            binary: false,
            truncated: false,
          },
        },
      ],
    };
    const { props } = setup({ loadSnapshot: async () => state });
    fireEvent.click(
      await screen.findByRole("button", { name: "gitIntegration.open" }),
    );
    expect(props.openFile).toHaveBeenCalledExactlyOnceWith("src/冲突 file.ts");
    fireEvent.click(
      screen.getByRole("button", { name: "gitRepo.continueIntegration" }),
    );
    expect(props.request).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole("button", { name: "gitRepo.abortIntegration" }),
    );
    expect(props.request).toHaveBeenCalledExactlyOnceWith(
      {
        kind: "abortIntegration",
        sessionId,
        expectedStateToken: state.stateToken,
      },
      state.head,
    );
  });
  it("never exposes continue or abort for external or unconfirmed ownership", async () => {
    const { props } = setup({
      loadSnapshot: async () => ({
        ...active(),
        owned: false,
        sessionId: null,
        canContinue: false,
      }),
    });
    await screen.findByText("gitIntegration.external");
    expect(
      screen.queryByRole("button", { name: "gitRepo.abortIntegration" }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "gitRepo.continueIntegration" }),
    ).toBeNull();
    expect(props.request).not.toHaveBeenCalled();
  });
  it("blocks old state while refreshing and then uses the newly observed session", async () => {
    let complete!: (state: GitIntegrationSnapshot) => void;
    let count = 0;
    const { props } = setup({
      loadSnapshot: () =>
        ++count === 1
          ? Promise.resolve(active())
          : new Promise((resolve) => {
              complete = resolve;
            }),
    });
    await screen.findByText("gitIntegration.pending");
    fireEvent.click(screen.getByRole("button", { name: "gitRepo.refresh" }));
    fireEvent.click(
      screen.getByRole("button", { name: "gitRepo.abortIntegration" }),
    );
    expect(props.request).not.toHaveBeenCalled();
    const next = {
      ...active(),
      sessionId: "22222222-2222-4222-8222-222222222222",
      stateToken: "d".repeat(64),
      message: "Updated sequence",
    };
    await act(async () => complete(next));
    await screen.findByText("Updated sequence");
    fireEvent.click(
      screen.getByRole("button", { name: "gitRepo.abortIntegration" }),
    );
    expect(props.request).toHaveBeenCalledExactlyOnceWith(
      {
        kind: "abortIntegration",
        sessionId: next.sessionId,
        expectedStateToken: next.stateToken,
      },
      next.head,
    );
  });
  it("rejects foreign repository responses without automatic retry or mutation", async () => {
    const loadSnapshot = vi.fn(async () => ({
      ...active(),
      repositoryId: "foreign",
    }));
    const { props } = setup({ loadSnapshot });
    await screen.findByText("gitIntegration.changed");
    expect(
      screen.queryByRole("button", { name: "gitRepo.abortIntegration" }),
    ).toBeNull();
    expect(loadSnapshot).toHaveBeenCalledTimes(1);
    expect(props.request).not.toHaveBeenCalled();
  });
});
