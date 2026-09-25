import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { UsageProvider } from "@armadra/shared";

const providerStatus = vi.fn();
vi.mock("../../api/client", () => ({
  runtimeApi: { providerStatus: () => providerStatus() },
}));

import { ProviderCard } from "./ProviderCard";
import { incidentFor } from "./provider-status";

afterEach(() => {
  cleanup();
  providerStatus.mockReset();
});

function report(indicator: string, enabled = true) {
  return {
    enabled,
    providers: [
      {
        id: "anthropic",
        indicator,
        description: "Elevated errors",
        pageUrl: "https://status.anthropic.com",
        checkedAt: "2026-09-26T00:00:00.000Z",
      },
    ],
  } as never;
}

describe("incidentFor", () => {
  it("only reports an actual incident, mapped from the usage provider", () => {
    expect(incidentFor(report("major"), "claude")?.indicator).toBe("major");
    expect(incidentFor(report("major"), "codex")).toBeNull();
    expect(incidentFor(report("none"), "claude")).toBeNull();
    // 取不到状态页不等于对方出事。
    expect(incidentFor(report("unknown"), "claude")).toBeNull();
    expect(incidentFor(report("critical", false), "claude")).toBeNull();
    expect(incidentFor(undefined, "claude")).toBeNull();
  });
});

describe("the incident badge on a provider card", () => {
  it("shows when the status page reports an incident", async () => {
    providerStatus.mockResolvedValue(report("major"));
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const provider = {
      id: "claude",
      status: "unavailable",
      windows: [],
    } as unknown as UsageProvider;
    render(
      <QueryClientProvider client={client}>
        <ProviderCard provider={provider} now={Date.now()} />
      </QueryClientProvider>,
    );
    const badge = await screen.findByText("部分中断");
    expect(badge.getAttribute("title")).toBe("Elevated errors");
  });
});
