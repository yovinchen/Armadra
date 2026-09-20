import type {
  CostAgent,
  CostModel,
  CostPoint,
  CostRange,
  CostSummary,
  CostTokens,
  CostWindow,
} from "@armadra/shared";

/**
 * 看板的样例数据。测试与本地预览用，生产代码路径不引用它。
 */

const MODELS = [
  "claude-opus-5",
  "claude-sonnet-4-5",
  "gpt-6-codex",
  "claude-haiku-4-5",
  "gpt-6-mini",
  "o5-preview",
  "gemini-3-pro",
  "llama-4-70b",
] as const;

const LOCAL_AGENTS = ["claude", "codex"] as const;
const AGENTS = ["claude", "codex", "opencode", "pi", "omp", "copilot"] as const;

function tokens(scale: number): CostTokens {
  return {
    input: Math.round(scale * 1_200),
    output: Math.round(scale * 340),
    cacheRead: Math.round(scale * 4_800),
    cacheCreation: Math.round(scale * 900),
  };
}

function total(value: CostTokens): number {
  return value.input + value.output + value.cacheRead + value.cacheCreation;
}

function add(a: CostTokens, b: CostTokens): CostTokens {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheCreation: a.cacheCreation + b.cacheCreation,
  };
}

const EMPTY: CostTokens = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheCreation: 0,
};

/** 伪随机但确定：同一个 key 永远给同一个强度，快照才稳定。 */
function weight(key: string, salt: number): number {
  let hash = salt * 2654435761;
  for (let index = 0; index < key.length; index += 1) {
    hash = (hash * 31 + key.charCodeAt(index)) % 1_000_003;
  }
  return (hash % 100) / 100;
}

function point(key: string, scale: number): CostPoint {
  const models: CostModel[] = MODELS.filter(
    (_, index) => weight(key, index + 1) > 0.25,
  ).map((model, index) => {
    const modelTokens = tokens(scale * (1 - index * 0.1) * weight(key, index));
    return {
      model,
      tokens: modelTokens,
      costUsd: model === "llama-4-70b" ? null : total(modelTokens) / 400_000,
    };
  });
  const agents: CostAgent[] = AGENTS.map((agent) => {
    const local = (LOCAL_AGENTS as readonly string[]).includes(agent);
    const agentTokens = local
      ? tokens(scale * weight(`${key}:${agent}`, 7))
      : EMPTY;
    return {
      agent,
      tokens: agentTokens,
      costUsd: local ? total(agentTokens) / 400_000 : 0,
      complete: true,
      source: local ? "local" : "none",
    };
  });
  const summed = models.reduce((acc, model) => add(acc, model.tokens), EMPTY);
  return {
    key,
    tokens: summed,
    costUsd: models.reduce((acc, model) => acc + (model.costUsd ?? 0), 0),
    complete: models.every((model) => model.costUsd !== null),
    models,
    agents,
  };
}

function rollUp(points: CostPoint[], granularity: "hour" | "day"): CostRange {
  const byModel = new Map<string, CostModel>();
  const byAgent = new Map<string, CostAgent>();
  for (const entry of points) {
    for (const model of entry.models) {
      const seen = byModel.get(model.model);
      byModel.set(model.model, {
        model: model.model,
        tokens: add(seen?.tokens ?? EMPTY, model.tokens),
        costUsd:
          model.costUsd === null
            ? null
            : (seen?.costUsd ?? 0) + (model.costUsd ?? 0),
      });
    }
    for (const agent of entry.agents) {
      const seen = byAgent.get(agent.agent);
      byAgent.set(agent.agent, {
        agent: agent.agent,
        tokens: add(seen?.tokens ?? EMPTY, agent.tokens),
        costUsd: (seen?.costUsd ?? 0) + agent.costUsd,
        complete: true,
        source: agent.source,
      });
    }
  }
  const totals: CostWindow = {
    tokens: points.reduce((acc, entry) => add(acc, entry.tokens), EMPTY),
    costUsd: points.reduce((acc, entry) => acc + entry.costUsd, 0),
    complete: points.every((entry) => entry.complete),
    models: [...byModel.values()],
  };
  const peak = points.reduce<CostPoint | null>(
    (best, entry) =>
      best === null || total(entry.tokens) > total(best.tokens) ? entry : best,
    null,
  );
  let streak = 0;
  let longest = 0;
  for (const entry of points) {
    streak = total(entry.tokens) > 0 ? streak + 1 : 0;
    longest = Math.max(longest, streak);
  }
  return {
    granularity,
    points,
    totals,
    byModel: [...byModel.values()].sort(
      (a, b) => (b.costUsd ?? 0) - (a.costUsd ?? 0),
    ),
    byAgent: AGENTS.map(
      (agent) =>
        byAgent.get(agent) ?? {
          agent,
          tokens: EMPTY,
          costUsd: 0,
          complete: true,
          source: "none",
        },
    ),
    peak: peak
      ? { key: peak.key, tokens: peak.tokens, costUsd: peak.costUsd }
      : null,
    activeIntervals: points.filter((entry) => total(entry.tokens) > 0).length,
    longestStreak: longest,
  };
}

function days(count: number, end = "2026-09-20"): string[] {
  const last = Date.parse(`${end}T00:00:00Z`);
  return Array.from({ length: count }, (_, index) =>
    new Date(last - (count - 1 - index) * 86_400_000)
      .toISOString()
      .slice(0, 10),
  );
}

export function sampleCostSummary(): CostSummary {
  const hours = Array.from(
    { length: 24 },
    (_, index) => `2026-09-20T${String(index).padStart(2, "0")}`,
  ).map((key, index) => point(key, index > 6 ? 0.6 : 0.1));
  const last30 = days(30).map((key, index) => point(key, 0.4 + index * 0.06));
  const all = days(45).map((key, index) => point(key, 0.2 + index * 0.05));

  const ranges = {
    "24h": rollUp(hours, "hour"),
    "7d": rollUp(last30.slice(-7), "day"),
    "30d": rollUp(last30, "day"),
    all: rollUp(all, "day"),
  };

  return {
    status: "ok",
    today: ranges["24h"].totals,
    last30Days: ranges["30d"].totals,
    currentSession: {
      provider: "claude",
      models: ["claude-opus-5"],
      tokens: tokens(0.3),
      costUsd: 0.42,
      complete: true,
      updatedAt: "2026-09-20T09:30:00Z",
    },
    daily: last30.map((entry) => ({
      date: entry.key,
      tokens: entry.tokens,
      costUsd: entry.costUsd,
      complete: entry.complete,
      models: entry.models,
    })),
    ranges,
    unpricedModels: ["llama-4-70b"],
    files: { claude: 12, codex: 5 },
    truncated: false,
    scannedAt: "2026-09-20T09:35:00Z",
  };
}
