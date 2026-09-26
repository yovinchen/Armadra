import type { DatabaseSync } from "node:sqlite";

/**
 * 哪些浏览器节点此刻被某个 Agent 连着。
 *
 * 桌面壳的调试器原本在 Agent 第一次驱动时才接上，之前页面打出的控制台与发出
 * 的请求一条都没记下——而 Agent 最常问的恰恰是「刚才报了什么错」。现在节点一
 * 被 Agent 连线，壳就以被动方式接上（只订阅 Runtime / Log / Network 三路事
 * 件，不驱动任何东西，`main/browser/observe.ts`），最后一条连线断开再摘掉。
 *
 * 「连着」按浏览器动词授权用的同一份事实算：一个终端节点的链接文档里有一条
 * `kind: "browser"` 的链接——驱动的授权也只问这个，普通终端里手动起的 CLI
 * 同样能驱动。浏览器与便签、文件树之间的线不算：那些线的另一头不会有人来读
 * 控制台。
 *
 * headless 后端不需要这一套：它从开标签页起就在记。
 */

export function linkedBrowserNodes(database: DatabaseSync): string[] {
  const rows = database
    .prepare(
      "SELECT c.links_json AS links_json " +
        "FROM context_links c JOIN nodes n ON n.id = c.node_id " +
        "WHERE n.type = 'terminal'",
    )
    .all() as unknown as Array<{ links_json: string }>;
  const linked = new Set<string>();
  for (const row of rows) {
    let links: unknown;
    try {
      links = JSON.parse(row.links_json);
    } catch {
      continue;
    }
    if (!Array.isArray(links)) continue;
    for (const link of links) {
      if (
        link !== null &&
        typeof link === "object" &&
        (link as { kind?: unknown }).kind === "browser" &&
        typeof (link as { id?: unknown }).id === "string"
      )
        linked.add((link as { id: string }).id);
    }
  }
  // 只留还在画布上的浏览器节点：链接文档可能比画布晚一步。
  if (linked.size === 0) return [];
  const present = database
    .prepare("SELECT id FROM nodes WHERE type = 'browser'")
    .all() as unknown as Array<{ id: string }>;
  return present
    .map((row) => row.id)
    .filter((id) => linked.has(id))
    .sort();
}

/**
 * 把「连着的浏览器节点」整份推给壳：连线一变、通道一接通都推一次。整份而不是
 * 增减，壳或 core 重启之后也不用去对漏了哪条。同一份不重复推。
 */
export class BrowserObservation {
  private last: string | undefined;
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly database: DatabaseSync,
    private readonly send: (nodeIds: readonly string[]) => void,
  ) {}

  /** 连线可能一次改好几份链接文档：攒一下再算。 */
  changed(): void {
    if (this.timer !== undefined) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.push(false);
    }, 50);
    this.timer.unref?.();
  }

  /** 通道刚接通：壳那边是空的，无论如何推一次。 */
  resync(): void {
    this.push(true);
  }

  private push(force: boolean): void {
    let ids: string[];
    try {
      ids = linkedBrowserNodes(this.database);
    } catch {
      return;
    }
    const key = ids.join(",");
    if (!force && key === this.last) return;
    this.last = key;
    this.send(ids);
  }

  close(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }
}
