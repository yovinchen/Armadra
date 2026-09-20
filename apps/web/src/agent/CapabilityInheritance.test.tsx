import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { usePreferencesStore } from "@/app/preferences-store";
import { CapabilityInheritance } from "./CapabilityInheritance";

beforeEach(() => usePreferencesStore.setState({ locale: "en" }));
afterEach(cleanup);
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
    fireEvent.click(screen.getByRole("checkbox", { name: /Account usage/ }));
    expect(changed).toHaveBeenCalledWith(["usage"]);
    rendered.rerender(
      <CapabilityInheritance
        baseAgent="copilot"
        disabledCapabilities={[]}
        onChange={changed}
      />,
    );
    // copilot declares neither an account-usage nor a subagent adapter, so
    // neither checkbox appears; the status hooks it does have still do.
    expect(
      screen.queryByRole("checkbox", { name: /Account usage/ }),
    ).toBeNull();
    expect(screen.queryByRole("checkbox", { name: /Subagents/ })).toBeNull();
    expect(screen.getByRole("checkbox", { name: /Status hooks/ })).toBeTruthy();
  });

  it("names the stage that decided each capability", () => {
    render(
      <CapabilityInheritance
        baseAgent="claude"
        disabledCapabilities={["usage"]}
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
