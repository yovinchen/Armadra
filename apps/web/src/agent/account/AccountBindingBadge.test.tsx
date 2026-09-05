import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import { usePreferencesStore } from "@/app/preferences-store";
import { AccountBindingBadge } from "./AccountBindingBadge";

beforeEach(() => usePreferencesStore.setState({ locale: "en" }));
afterEach(cleanup);

describe("AccountBindingBadge", () => {
  it("takes no space while the reserved field is absent", () => {
    const { container } = render(
      <AccountBindingBadge agent={{ id: "claude" }} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("shows the account a node declares and says binding is not enabled", () => {
    render(
      <AccountBindingBadge
        agent={{
          id: "claude",
          account: {
            accountId: "work-1",
            providerId: "claude",
            label: "Work",
            credentialRef: "keychain://armadra/claude/work-1",
          },
        }}
      />,
    );
    const badge = screen.getByText("Work");
    expect(badge.closest("[title]")?.getAttribute("title")).toContain(
      "not enabled",
    );
    // A credential reference is a name in a credential store; it is not shown.
    expect(document.body.textContent).not.toContain("keychain");
  });

  it("falls back to the account id when there is no label", () => {
    render(
      <AccountBindingBadge
        agent={{ id: "claude", account: { accountId: "work-1" } }}
      />,
    );
    expect(screen.getByText("work-1")).toBeTruthy();
  });
});
