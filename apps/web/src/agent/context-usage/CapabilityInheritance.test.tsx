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
