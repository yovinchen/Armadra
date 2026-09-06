/**
 * localStorage 读写的最小封装：读失败视为没有值，写失败静默——隐私模式
 * 与被禁用的站点存储都不该让偏好本身不可用。
 */
export function readStored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeStored(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // 隐私模式下写不进去；内存里的值仍然有效
  }
}

export function storedEnum<T extends string>(
  key: string,
  allowed: readonly T[],
  fallback: T,
): T {
  const value = readStored(key) as T | null;
  return value && allowed.includes(value) ? value : fallback;
}

export function storedBoolean(key: string, fallback: boolean): boolean {
  const raw = readStored(key);
  if (raw === "true") return true;
  if (raw === "false") return false;
  return fallback;
}

export function storedNumber(
  key: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = readStored(key);
  if (raw === null) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

/** `Record<string, string>` 形状的偏好；坏数据当作没存过。 */
export function storedRecord(key: string): Record<string, string> {
  const raw = readStored(key);
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return {};
    const result: Record<string, string> = {};
    for (const [id, value] of Object.entries(parsed)) {
      if (typeof value === "string") result[id] = value;
    }
    return result;
  } catch {
    return {};
  }
}

export function storedIds(key: string): string[] {
  const raw = readStored(key);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

/**
 * 节点颜色风格（§24.3-3）。
 *
 * `dot`（默认）= 头部左上 8px 色点 + 1px 顶部描边，克制；
 * `bar` = 旧的 3px 顶部色条，颜色更抢眼。设置页在「界面」分区里暴露它。
 */
