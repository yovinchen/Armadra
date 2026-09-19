/**
 * 「这是不是 Electron 壳」的本目录判定（electron-migration.md §5 W3.1）。
 *
 * 壳的 preload 是页面能拿到 `window.armadra` 的唯一来源（`apps/desktop/src/
 * preload/index.ts`），所以它在不在就是「宿主有没有 `<webview>`」的充要条件。
 * W5 会把 `isTauri()` 的 14 个调用点一起换成统一的 `isDesktop()`；在那之前这
 * 个判定只服务浏览器节点，**故意**留在本目录里而不是 `@/platform`——W3.5 之
 * 前旧的 screencast 路径是唯一回退，两条路必须能各自独立地开关。
 */

/** 壳在不在。浏览器、Node 测试环境与 Tauri 壳都是 false。 */
export function isDesktopShell(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof (window as { armadra?: unknown }).armadra !== "undefined"
  );
}

/**
 * 一个 guest 的 `partition`（[浏览器节点](browser-node.md) §2.3，探针 C）。
 *
 * 同一个工作空间的所有用户节点共享一个 jar，所以在 A 节点登录过的站点在 B
 * 节点里仍然是登录的；Agent 开的节点走**另一个** jar，它的登录态不会被人
 * 误当成自己的。两者都带 `persist:` 前缀，关掉应用再开还在。
 *
 * **创建时定一次、永不变更**：Electron 只在 attach 时读这个属性，attach 之后
 * 再改会被静默忽略（探针 C）——改了不报错、也不生效，于是一个「换了 partition
 * 就该退出登录」的节点会继续用着旧 jar，这比报错难查得多。
 */
export function browserPartition(
  workspaceId: string | undefined,
  driver: "user" | "agent",
): string {
  const scope = workspaceId ?? "default";
  return driver === "agent"
    ? `persist:armadra-agent-browser-${scope}`
    : `persist:armadra-browser-${scope}`;
}
