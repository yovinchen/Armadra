import {
  ageContextUsage,
  contextLevel,
  contextPercentage,
  DEFAULT_CONTEXT_THRESHOLDS,
  type ContextThresholds,
  type ContextUsage,
} from "@armadra/shared";
import type { Translate } from "@/app/preferences-store";

/**
 * 上下文占用那一行的全部内容，算成纯数据（Agent 自动化设计 §2.2）。
 *
 * 抽出来是因为 F5 把它从头部的徽标改成了 `···` 菜单里的一行：渲染壳换了，
 * 但「百分之多少、凭什么这么说、要不要提醒」这三件事一个字都不该变。放在
 * 纯函数里，它们也就不必隔着一个 Radix 菜单去测。
 */
export interface ContextUsageViewInput {
  nodeId: string;
  sessionId: string | null;
  generation: number | null;
  usage: ContextUsage | null;
  /** 会话已经结束这类「不必再等上报」的原因，由调用方给。 */
  unavailableReason?: ContextUsage["unknownReason"];
  /** 从收到这份快照到现在过去了多久；不传就当作刚刚收到。 */
  elapsedMs?: number;
  /** 设置 → Agent 的阈值；缺省只是测试用的兜底。 */
  thresholds?: ContextThresholds;
}

export interface ContextUsageView {
  /** `8%` / `~8%` / `未知`。 */
  value: string;
  /** 菜单那一行显示的文字，已经带上「已过期」这类后缀。 */
  text: string;
  /** 无障碍名，例如 `上下文占用 8%`。 */
  label: string;
  quality: ContextUsage["quality"];
  level: ReturnType<typeof contextLevel>;
  percentage: number | null;
  /** 详情标题：`会话上下文 · 已上报`。 */
  title: string;
  rows: readonly (readonly [string, string])[];
  notes: readonly string[];
}

/**
 * 只认**当前绑定**的快照：节点、会话、代次三者全对上才算数。
 * 对不上就是「还没有人报过」——不是 0%，也不是上一代的数字。
 */
export function contextUsageView(
  input: ContextUsageViewInput,
  t: Translate,
): ContextUsageView {
  const limits =
    input.thresholds ??
    (DEFAULT_CONTEXT_THRESHOLDS satisfies ContextThresholds);
  const matched =
    input.usage &&
    input.usage.nodeId === input.nodeId &&
    input.usage.sessionId === input.sessionId &&
    input.usage.generation === input.generation
      ? ageContextUsage(input.usage, Math.max(0, input.elapsedMs ?? 0))
      : null;
  const percentage = matched ? contextPercentage(matched) : null;
  // `null` for an unknown reading: an absent observation is not "normal", and
  // it must not colour the row or trip a reminder.
  const level = contextLevel(percentage, limits);
  const quality = matched?.quality ?? "unknown";
  const unknown = t("context.unknown");
  const value =
    percentage === null
      ? unknown
      : `${quality === "estimated" ? "~" : ""}${Math.round(percentage)}%`;
  const text = `${value}${quality === "stale" ? ` · ${t("context.stale")}` : ""}`;
  const reason =
    matched?.unknownReason ?? input.unavailableReason ?? "awaiting_report";
  const number = (input: number | null | undefined) =>
    input == null ? unknown : input.toLocaleString();

  const rows: (readonly [string, string])[] = [
    [t("context.model"), matched?.modelId ?? unknown],
    [t("context.session"), input.sessionId ?? unknown],
    [t("context.providerSession"), matched?.providerSessionId ?? unknown],
    [t("context.used"), number(matched?.usedTokens)],
    [t("context.capacity"), number(matched?.capacityTokens)],
    [t("context.reserved"), number(matched?.reservedOutputTokens)],
    [t("context.source"), t(`context.${matched?.source ?? "unavailable"}`)],
    [
      t("context.observed"),
      matched?.observedAt
        ? new Date(matched.observedAt).toLocaleString()
        : unknown,
    ],
    [t("context.generation"), number(input.generation)],
    [
      t("context.compaction"),
      matched && matched.source !== "unavailable"
        ? number(matched.compactionEpoch)
        : unknown,
    ],
    [t("context.revision"), matched?.sourceRevision ?? unknown],
  ];
  if (matched?.estimate) {
    rows.push([
      t("context.estimator"),
      `${matched.estimate.heuristic} · ${t(`context.confidence.${matched.estimate.confidence}`)}`,
    ]);
  }

  const notes: string[] = [];
  if (quality === "unknown") {
    notes.push(t(`context.${reason}`));
    if (reason === "awaiting_report") notes.push(t("context.setupNote"));
  }
  if (quality === "estimated") {
    notes.push(t("context.estimateNote"));
    if (matched?.estimate) {
      notes.push(
        t("context.estimateDetail", {
          heuristic: matched.estimate.heuristic,
          confidence: t(`context.confidence.${matched.estimate.confidence}`),
          messages: matched.estimate.messages,
        }),
      );
    }
    if (matched?.estimate?.truncated) notes.push(t("context.estimateFloor"));
  }
  if (quality === "stale") notes.push(t("context.staleNote"));
  if (level === "warn")
    notes.push(t("context.high", { percent: limits.warnPercent }));
  if (level === "danger")
    notes.push(t("context.critical", { percent: limits.dangerPercent }));
  notes.push(t("context.explanation"), t("context.restartNote"));

  return {
    value,
    text,
    label: t("context.badge", { value }),
    quality,
    level,
    percentage,
    title: `${t("context.title")} · ${t(`context.${quality}`)}`,
    rows,
    notes,
  };
}
