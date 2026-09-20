/**
 * 人自己点下来的下载，页面这一侧。
 *
 * 分工：**决定存哪儿的是主进程**（`shell-core/browser/downloads.ts` +
 * `main/browser/transfers.ts`），这里只负责「说一声」。人点了一个链接，文件
 * 静悄悄落进下载目录，画布上什么都没发生——那和没下载成功在体感上是一回事，
 * 复查 §2.1 把它记成「断裂」正是这个原因。
 *
 * Agent 引起的下载**不走这条路**：那些进暂存目录，出口只有
 * `download --accept`，在画布上冒一个「下载完成」会把一件还没被批准的事说成
 * 已经发生了。主进程按有没有租约分开这两类，这里收到的只有前者。
 */

/** 主进程送来的那一条。字段与 `StagedDownload` 的公开部分同名。 */
export interface DownloadNotice {
  /** `"completed"` / `"cancelled"` / `"interrupted"`。 */
  readonly state: string;
  /** 存下来的文件名（不是路径）。 */
  readonly filename: string;
  /** 绝对路径。空串表示这次没存下来，于是没有「在文件夹里显示」。 */
  readonly path: string;
  readonly bytes: number;
}

/**
 * 解析。缺 `state` 的一律丢掉——一条说不出结果的下载通知没有可说的内容。
 */
export function parseDownloadNotice(raw: unknown): DownloadNotice | null {
  if (typeof raw !== "object" || raw === null) return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.state !== "string" || value.state === "") return null;
  return {
    state: value.state,
    filename: typeof value.filename === "string" ? value.filename : "",
    path: typeof value.path === "string" ? value.path : "",
    bytes: typeof value.bytes === "number" ? value.bytes : 0,
  };
}

/**
 * 这条通知该说成什么。纯函数，返回 i18n 键后缀，`null` 表示不值得打扰。
 *
 * `interrupted` 与 `cancelled` 分开：前者是「网断了／磁盘满了」，人可能想
 * 重试；后者是人自己按的取消，再弹一条只是复读。
 */
export function downloadToastKind(
  notice: DownloadNotice,
): "done" | "failed" | null {
  if (notice.state === "completed") return "done";
  if (notice.state === "interrupted") return "failed";
  return null;
}

/** 人读的大小。KB 以下不细分——一个 812 B 的文件说「1 KB」不会误导谁。 */
export function humanBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "";
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = units[0]!;
  for (const next of units.slice(1)) {
    if (value < 1024) break;
    value /= 1024;
    unit = next;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${unit}`;
}
