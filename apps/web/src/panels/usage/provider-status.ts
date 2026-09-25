import { useQuery } from "@tanstack/react-query";

import { runtimeApi } from "../../api/client";
import type { ProviderStatusReport } from "../../api/usage";

/**
 * 用量卡上的事故徽标（roadmap §3.9）。
 *
 * 用量 provider 与状态页一一对应：Claude → Anthropic，Codex → OpenAI，
 * Copilot → GitHub。只有状态页明确报了故障或维护才出徽标；`none` 与
 * `unknown` 都不画——前者没事可说，后者说不出什么（取不到状态页不等于对方
 * 出事）。
 */

const STATUS_PAGE_OF: Readonly<Record<string, string>> = {
  claude: "anthropic",
  codex: "openai",
  copilot: "github",
};

export type Incident = ProviderStatusReport["providers"][number] & {
  indicator: "minor" | "major" | "critical" | "maintenance";
};

/** 五分钟，与 Runtime 侧的缓存同一个节奏：问得再勤也只是读缓存。 */
const POLL_MS = 5 * 60_000;

export function incidentFor(
  report: ProviderStatusReport | undefined,
  usageProviderId: string,
): Incident | null {
  if (!report?.enabled) return null;
  const pageId = STATUS_PAGE_OF[usageProviderId];
  const entry = report.providers.find((each) => each.id === pageId);
  if (!entry || entry.indicator === "none" || entry.indicator === "unknown") {
    return null;
  }
  return entry as Incident;
}

export function useProviderIncident(usageProviderId: string): Incident | null {
  const status = useQuery({
    queryKey: ["usage-status"],
    queryFn: () => runtimeApi.providerStatus(),
    refetchInterval: POLL_MS,
    retry: false,
  });
  return incidentFor(status.data, usageProviderId);
}
