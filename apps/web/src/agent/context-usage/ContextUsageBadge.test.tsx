import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ContextUsage } from "@armadra/shared";
import { usePreferencesStore } from "@/app/preferences-store";
import { ContextUsageBadge } from "./ContextUsageBadge";
import { CapabilityInheritance } from "./CapabilityInheritance";

const usage = (): ContextUsage => ({
  nodeId: "node",
  sessionId: "session",
  generation: 2,
  providerSessionId: "provider",
  modelId: "fixture-model",
  usedTokens: 15500,
  capacityTokens: 200000,
  reservedOutputTokens: null,
  ageMs: 0,
  observedAt: new Date().toISOString(),
  quality: "reported",
  source: "provider_hook",
  sourceRevision: "10",
  compactionEpoch: 1,
  unknownReason: null,
});
beforeEach(() =>
  usePreferencesStore.setState({
    locale: "en",
    contextThresholds: { warnPercent: 80, dangerPercent: 95 },
  }),
);
afterEach(cleanup);
function view(snapshot: ContextUsage | null = usage()) {
  return render(
    <ContextUsageBadge
      nodeId="node"
      sessionId="session"
      generation={2}
      usage={snapshot}
    />,
  );
}
describe("context badge", () => {
  it("shows current input percentage and explicitly unknown reserved output", () => {
    view();
    fireEvent.click(screen.getByRole("button", { name: "Context 8%" }));
    expect(screen.getByText("15,500")).toBeTruthy();
    expect(screen.getByText("200,000")).toBeTruthy();
    expect(
      screen.getByText("Reserved output").nextElementSibling?.textContent,
    ).toBe("Unknown");
    expect(screen.getByText(/not cumulative billing/)).toBeTruthy();
    expect(
      screen.getByText("Source revision").nextElementSibling?.textContent,
    ).toBe("10");
  });
  it("never displays 0% for missing data, capacity, or an obsolete generation", () => {
    const rendered = view(null);
    expect(
      screen.getByRole("button", { name: "Context Unknown" }),
    ).toBeTruthy();
    for (const snapshot of [
      { ...usage(), capacityTokens: null },
      { ...usage(), generation: 1 },
      { ...usage(), sessionId: "old" },
    ]) {
      rendered.rerender(
        <ContextUsageBadge
          nodeId="node"
          sessionId="session"
          generation={2}
          usage={snapshot}
        />,
      );
      expect(
        screen.getByRole("button", { name: "Context Unknown" }),
      ).toBeTruthy();
      expect(screen.queryByText("0%")).toBeNull();
    }
  });
  it("marks stale and estimated observations without relabeling them reported", () => {
    const rendered = view({
      ...usage(),
      quality: "estimated",
      source: "tokenizer_estimate",
    });
    fireEvent.click(screen.getByRole("button", { name: "Context ~8%" }));
    expect(screen.getByText(/estimate may omit/)).toBeTruthy();
    rendered.unmount();
    view({ ...usage(), ageMs: 301000 });
    fireEvent.click(screen.getByRole("button", { name: "Context 8%" }));
    expect(screen.getByText(/No new observation/)).toBeTruthy();
    expect(screen.getByText(/Session context · Stale/)).toBeTruthy();
  });
  it("colours and warns by the configured thresholds, not hardcoded ones", () => {
    // 8 % is normal by default; with a 5 %/7 % pair it is already critical.
    usePreferencesStore.setState({
      contextThresholds: { warnPercent: 5, dangerPercent: 7 },
    });
    view();
    fireEvent.click(screen.getByRole("button", { name: "Context 8%" }));
    expect(screen.getByText(/over 7%/)).toBeTruthy();
    expect(screen.queryByText(/over 5%/)).toBeNull();
    cleanup();
    usePreferencesStore.setState({
      contextThresholds: { warnPercent: 5, dangerPercent: 50 },
    });
    view();
    fireEvent.click(screen.getByRole("button", { name: "Context 8%" }));
    expect(screen.getByText(/over 5%/)).toBeTruthy();
  });

  it("reports which heuristic produced an estimate and how far it reached", () => {
    view({
      ...usage(),
      quality: "estimated",
      source: "structured_transcript",
      sourceRevision: null,
      estimate: {
        heuristic: "chars-v1",
        confidence: "low",
        sampledBytes: 8192,
        truncated: true,
        messages: 42,
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "Context ~8%" }));
    expect(screen.getByText(/Structured transcript/)).toBeTruthy();
    expect(screen.getByText(/chars-v1, low confidence/)).toBeTruthy();
    expect(screen.getByText(/42 transcript messages/)).toBeTruthy();
    // A truncated read is a floor and says so, rather than reading as a total.
    expect(screen.getByText(/this is a floor/)).toBeTruthy();
  });

  it("resets the expanded details when the binding changes and constrains the popover", () => {
    const rendered = view();
    fireEvent.click(screen.getByRole("button", { name: "Context 8%" }));
    rendered.rerender(
      <ContextUsageBadge
        nodeId="node"
        sessionId="new-session"
        generation={1}
        usage={usage()}
      />,
    );
    expect(screen.queryByText("15,500")).toBeNull();
    expect(screen.getByRole("dialog").className).toContain(
      "max-w-[calc(100vw-1rem)]",
    );
  });
});
describe("capability inheritance", () => {
  it("offers only the chosen base's abilities and sends a narrowing list", () => {
    const changed = vi.fn();
    const rendered = render(
      <CapabilityInheritance
        baseAgent="claude"
        disabledCapabilities={[]}
        onChange={changed}
      />,
    );
    // The accessible name now carries the resolved state and its source, so
    // the label is matched rather than compared whole.
    fireEvent.click(screen.getByRole("checkbox", { name: /Session context/ }));
    expect(changed).toHaveBeenCalledWith(["contextUsage"]);
    rendered.rerender(
      <CapabilityInheritance
        baseAgent="gemini"
        disabledCapabilities={[]}
        onChange={changed}
      />,
    );
    // gemini reads its own transcript, so it does declare session context; it
    // has no subagent adapter, so that one never appears.
    expect(
      screen.getByRole("checkbox", { name: /Session context/ }),
    ).toBeTruthy();
    expect(screen.queryByRole("checkbox", { name: /Subagents/ })).toBeNull();
    expect(screen.getByRole("checkbox", { name: /Status hooks/ })).toBeTruthy();
  });

  it("names the stage that decided each capability", () => {
    render(
      <CapabilityInheritance
        baseAgent="claude"
        disabledCapabilities={["contextUsage"]}
        onChange={vi.fn()}
        probe={{
          agentId: "claude",
          launchCmd: "claude",
          version: "2.0.31",
          status: "ok",
          probedAt: new Date().toISOString(),
        }}
      />,
    );
    // The one the user switched off says so, rather than only looking greyed.
    expect(screen.getByText(/Unavailable · Custom configuration/)).toBeTruthy();
    expect(
      screen.getAllByText(/Available · Base adapter/).length,
    ).toBeGreaterThan(0);
  });

  it("warns that an unprobed CLI leaves capabilities unknown", () => {
    render(
      <CapabilityInheritance
        baseAgent="claude"
        disabledCapabilities={[]}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByText(/version was not detected/)).toBeTruthy();
  });
});
