import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { BoardDocument } from "@armadra/shared";

import { installDomPolyfills, TestProviders } from "@/app/test-harness";
import { usePreferencesStore } from "@/app/preferences-store";
import { useCanvasStore } from "@/store/canvas-store";
import { HandoffDialog, canWithdraw, isSettled } from "./HandoffDialog";
import { handoffTargets, openHandoff } from "./handoff-targets";

const api = vi.hoisted(() => ({
  prepareHandoff: vi.fn(),
  acceptHandoff: vi.fn(),
  cancelHandoff: vi.fn(),
  handoff: vi.fn(),
  sessions: vi.fn(),
  getTerminal: vi.fn(),
}));
vi.mock("@/api/client", () => ({ runtimeApi: api }));
vi.mock("@/api/events", () => ({ onWorkspaceEvent: () => () => undefined }));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

const SOURCE = "11111111-1111-4111-8111-111111111111";
const TARGET = "22222222-2222-4222-8222-222222222222";
const TARGET_SESSION = "33333333-3333-4333-8333-333333333333";

function terminalNode(id: string, title: string, agent: string | null) {
  return {
    id,
    boardId: "b",
    type: "terminal",
    title,
    x: 0,
    y: 0,
    width: 10,
    height: 10,
    data: {
      kind: "terminal",
      cwd: ".",
      ...(agent ? { agent: { id: agent } } : {}),
    },
  } as unknown as BoardDocument["nodes"][number];
}

function document(): BoardDocument {
  return {
    board: { id: "b" },
    nodes: [
      terminalNode(SOURCE, "Source", "claude"),
      terminalNode(TARGET, "Reviewer", "codex"),
      terminalNode("44444444-4444-4444-8444-444444444444", "Plain", null),
    ],
    edges: [
      { id: "e1", boardId: "b", source: SOURCE, target: TARGET, kind: "link" },
      {
        id: "e2",
        boardId: "b",
        source: SOURCE,
        target: "44444444-4444-4444-8444-444444444444",
        kind: "link",
      },
    ],
  } as unknown as BoardDocument;
}

function view(state: string, extra: Record<string, unknown> = {}) {
  return {
    bundle: {
      version: 1,
      handoffId: "55555555-5555-4555-8555-555555555555",
      workspaceId: "w",
      createdAt: "2026-09-05T00:00:00Z",
      source: { nodeId: SOURCE, agentId: "claude", modelId: null },
      target: {
        nodeId: TARGET,
        agentId: "codex",
        modelId: null,
        workingDirectory: "/tmp/project",
      },
      cutoff: { kind: "unavailable" },
      sections: { goal: "Continue" },
      transcriptExcerpt: "",
      trust: "peerDataNotSystemInstructions",
      sourcePreserved: true,
      files: [{ path: "src/api.rs", status: "referenced" }],
      git: { status: "unavailable", headOid: null },
      attachments: [],
      budget: {
        byteLimit: 8192,
        usedBytes: 1845,
        truncated: false,
        omitted: ["tokenBudgetUnavailable"],
      },
    },
    digest: "digest-of-the-preview",
    state,
    mailboxId: null,
    traceId: null,
    errorCode: null,
    acceptedAt: null,
    updatedAt: "2026-09-05T00:00:00Z",
    sourceHasNewActivity: false,
    ...extra,
  };
}

/** Radix 的 Select 要先用键盘打开才会渲染选项；jsdom 里没有真实指针。 */
async function chooseTarget(name: string) {
  const trigger = screen.getByRole("combobox", { name: "Target agent" });
  fireEvent.keyDown(trigger, { key: "ArrowDown" });
  fireEvent.click(await screen.findByRole("option", { name }));
}

beforeEach(() => {
  installDomPolyfills();
  usePreferencesStore.setState({ locale: "en" });
  useCanvasStore.setState({
    workspace: { id: "w" },
    document: document(),
  } as never);
  for (const call of Object.values(api)) call.mockReset();
  api.sessions.mockResolvedValue([
    { nodeId: TARGET, sessionId: TARGET_SESSION },
  ]);
  api.getTerminal.mockResolvedValue({
    status: "running",
    generation: 4,
  });
  api.handoff.mockImplementation(() => new Promise(() => undefined));
});
afterEach(cleanup);

describe("handoff targets", () => {
  it("offers only linked agent terminals, never a plain terminal or itself", () => {
    expect(handoffTargets(document(), SOURCE)).toEqual([
      { nodeId: TARGET, title: "Reviewer", agentId: "codex" },
    ]);
    expect(handoffTargets(document(), TARGET)).toEqual([
      { nodeId: SOURCE, title: "Source", agentId: "claude" },
    ]);
  });
});

describe("handoff dialog", () => {
  it("previews before anything is sent and only accepts the digest it showed", async () => {
    api.prepareHandoff.mockResolvedValue(view("prepared"));
    api.acceptHandoff.mockResolvedValue(view("queued"));
    render(
      <TestProviders>
        <HandoffDialog />
      </TestProviders>,
    );
    openHandoff({ nodeId: SOURCE, sessionId: "s", generation: 2 });
    const goal = await screen.findByLabelText("Goal");
    fireEvent.change(goal, { target: { value: "Continue the review" } });
    // The target picker is a Radix select; setting it through the DOM is not
    // what is under test, so the choice is made the same way the mutation
    // reads it: by node id.
    await chooseTarget("Reviewer · Codex");
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));

    await waitFor(() => expect(api.prepareHandoff).toHaveBeenCalledTimes(1));
    const request = api.prepareHandoff.mock.calls[0]![1];
    expect(request.targetNodeId).toBe(TARGET);
    expect(request.targetSessionId).toBe(TARGET_SESSION);
    // The target generation comes from the runtime, not from a stale guess.
    expect(request.targetGeneration).toBe(4);
    expect(request.sourceGeneration).toBe(2);
    // Preparing must not have notified anyone.
    expect(api.acceptHandoff).not.toHaveBeenCalled();

    // The preview names what travels and what does not.
    expect(await screen.findByText(/src\/api\.rs/)).toBeTruthy();
    expect(screen.getByText("tokenBudgetUnavailable")).toBeTruthy();
    expect(screen.getByText("Git fingerprint unavailable")).toBeTruthy();
    expect(screen.getByText(/1845 \/ 8192 bytes/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Confirm handoff" }));
    await waitFor(() => expect(api.acceptHandoff).toHaveBeenCalledTimes(1));
    expect(api.acceptHandoff).toHaveBeenCalledWith(
      "w",
      "55555555-5555-4555-8555-555555555555",
      "digest-of-the-preview",
    );
    expect(
      await screen.findByText("Queued until the target is idle"),
    ).toBeTruthy();
  });

  it("withdraws the frozen bundle when the user goes back to editing", async () => {
    api.prepareHandoff.mockResolvedValue(view("prepared"));
    api.cancelHandoff.mockResolvedValue(view("cancelled"));
    render(
      <TestProviders>
        <HandoffDialog />
      </TestProviders>,
    );
    openHandoff({ nodeId: SOURCE, sessionId: "s", generation: 2 });
    fireEvent.change(await screen.findByLabelText("Goal"), {
      target: { value: "Continue" },
    });
    await chooseTarget("Reviewer · Codex");
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    await screen.findByRole("button", { name: "Back to editing" });
    fireEvent.click(screen.getByRole("button", { name: "Back to editing" }));
    await waitFor(() => expect(api.cancelHandoff).toHaveBeenCalledTimes(1));
    // Back at the form, and nothing was accepted along the way.
    expect(await screen.findByLabelText("Goal")).toBeTruthy();
    expect(api.acceptHandoff).not.toHaveBeenCalled();
  });

  it("reports a written notice as written, not as work the target has done", async () => {
    api.prepareHandoff.mockResolvedValue(view("notified"));
    render(
      <TestProviders>
        <HandoffDialog />
      </TestProviders>,
    );
    openHandoff({ nodeId: SOURCE, sessionId: "s", generation: 2 });
    fireEvent.change(await screen.findByLabelText("Goal"), {
      target: { value: "Continue" },
    });
    await chooseTarget("Reviewer · Codex");
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    expect(
      await screen.findByText("Notice written to the target's input"),
    ).toBeTruthy();
    expect(screen.getByText(/without pressing Return/)).toBeTruthy();
    // A written notice can no longer be withdrawn, so no withdraw button.
    expect(screen.queryByRole("button", { name: "Withdraw" })).toBeNull();
  });

  it("surfaces an unknown write outcome as unknown", async () => {
    api.prepareHandoff.mockResolvedValue(
      view("unknownOutcome", { errorCode: "writeOutcomeUnknown" }),
    );
    render(
      <TestProviders>
        <HandoffDialog />
      </TestProviders>,
    );
    openHandoff({ nodeId: SOURCE, sessionId: "s", generation: 2 });
    fireEvent.change(await screen.findByLabelText("Goal"), {
      target: { value: "Continue" },
    });
    await chooseTarget("Reviewer · Codex");
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    expect(await screen.findByText("Write outcome unknown")).toBeTruthy();
    expect(screen.getByText("Reason: writeOutcomeUnknown")).toBeTruthy();
  });
});

describe("delivery state predicates", () => {
  it("allows withdrawal only before the target was written to", () => {
    expect(canWithdraw("prepared")).toBe(true);
    expect(canWithdraw("queued")).toBe(true);
    expect(canWithdraw("dispatching")).toBe(false);
    expect(canWithdraw("notified")).toBe(false);
    expect(canWithdraw("unknownOutcome")).toBe(false);
  });
  it("keeps polling while an outcome can still change", () => {
    expect(isSettled("queued")).toBe(false);
    expect(isSettled("notified")).toBe(false);
    // An unknown outcome can still be resolved by a target acknowledgement.
    expect(isSettled("unknownOutcome")).toBe(false);
    expect(isSettled("acknowledged")).toBe(true);
    expect(isSettled("cancelled")).toBe(true);
  });
});
