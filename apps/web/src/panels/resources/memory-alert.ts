/**
 * 内存越线提醒：**每个会话一次**（路线图 §4.3）。
 *
 * 采样是每几秒一次的，越线之后每一份样本都还在越线上。所以提醒必须按会话
 * 去重，否则一个跑构建的 Agent 会在两分钟里发四十条通知——那不是提醒，那是
 * 刷屏，用户学会的第一件事就是把通知关掉。
 *
 * 去重的键是 `sessionId:generation`：换代（重启会话）是新的一次运行，值得
 * 重新提醒一次；同一次运行里在阈值上下抖动则不会。
 *
 * 提醒只是提醒：不终止、不休眠、不压缩、不做任何处置。面板里的「结束会话」
 * 始终是用户自己点的（设计 §8「不自动杀最高占用会话」）。
 */

/** 已经提醒过的 `sessionId:generation`。 */
const alerted = new Set<string>();

/** 单次运行里不再重复；集合有上限，长时间开着也不会无限增长。 */
const MAX_REMEMBERED = 512;

export function alertKey(sessionId: string, generation: number): string {
  return `${sessionId}:${generation}`;
}

/**
 * 这一份样本是否**刚刚**越线。
 *
 * `null` 的内存永远不算越线：测不出来不是「超了」，把 unknown 当成越线会发出
 * 一条关于不存在的数字的通知。
 */
export function crossedThreshold(
  memoryBytes: number | null | undefined,
  thresholdBytes: number,
): boolean {
  return (
    typeof memoryBytes === "number" &&
    Number.isFinite(memoryBytes) &&
    memoryBytes >= thresholdBytes
  );
}

/**
 * 认领一次提醒机会。第一次返回 `true`，之后同一次运行里都返回 `false`。
 */
export function claimAlert(sessionId: string, generation: number): boolean {
  const key = alertKey(sessionId, generation);
  if (alerted.has(key)) return false;
  if (alerted.size >= MAX_REMEMBERED) {
    // 最旧的那条最不可能还在运行；`Set` 保持插入顺序，取第一个就够。
    const oldest = alerted.values().next();
    if (!oldest.done) alerted.delete(oldest.value);
  }
  alerted.add(key);
  return true;
}

/** 会话结束或换代时忘掉它，下一次运行可以重新提醒。 */
export function forgetAlert(sessionId: string, generation: number): void {
  alerted.delete(alertKey(sessionId, generation));
}

/** 测试用。 */
export function resetAlerts(): void {
  alerted.clear();
}
