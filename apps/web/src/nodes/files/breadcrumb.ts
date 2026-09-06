/**
 * 文件管理器的面包屑。
 *
 * 一格一级地列下去在真实路径上会撑爆节点：`/Users/name/Projects/…` 光是
 * 到工作空间根就已经四五格，再往下每进一层多一个箭头，最后每一格都被截成
 * 两三个字符，谁也认不出来。
 *
 * 所以显示的不是全部层级，而是**头一格、一个 `…`、最后两级**：
 *
 *   工作空间 › … › nodes › files
 *
 * 头一格永远是工作空间根（用工作空间名，没有就用根路径的最后一段），中间
 * 全部折进 `…`，点开是一份可以直接跳的中间各级菜单。窄节点只留最后一级。
 */

export type Crumb = { label: string; path: string };

/** 最后保留几级。窄节点收到 1。 */
export const DEFAULT_TAIL = 2;

/** 节点窄到这个宽度以下就只留最后一级。 */
export const NARROW_WIDTH = 260;

export function tailSizeFor(width: number | undefined): number {
  return typeof width === "number" && width < NARROW_WIDTH ? 1 : DEFAULT_TAIL;
}

/**
 * `a/b/c` → `[{label:"a",path:"a"}, {label:"b",path:"a/b"}, …]`，根目录单独
 * 一项排在最前。这是完整层级；折叠是 [`collapseCrumbs`] 的事。
 */
export function breadcrumbs(path: string, rootLabel: string): Crumb[] {
  const trimmed = path.replace(/^\.\/?/, "").replace(/^\/+|\/+$/g, "");
  const crumbs: Crumb[] = [{ label: rootLabel, path: "." }];
  if (!trimmed) return crumbs;
  let prefix = "";
  for (const segment of trimmed.split("/")) {
    if (!segment) continue;
    prefix = prefix ? `${prefix}/${segment}` : segment;
    crumbs.push({ label: segment, path: prefix });
  }
  return crumbs;
}

/**
 * 头一格永远显示的名字：工作空间名，退而求其次是根路径的最后一段，都没有
 * 才用「根目录」。
 */
export function rootLabelFor(
  workspaceName: string | undefined,
  rootPath: string | undefined,
  fallback: string,
): string {
  const name = workspaceName?.trim();
  if (name) return name;
  const last = rootPath
    ?.replace(/\/+$/, "")
    .split("/")
    .filter(Boolean)
    .pop()
    ?.trim();
  return last || fallback;
}

export type CollapsedCrumbs = {
  /** 工作空间根，永远显示。 */
  root: Crumb;
  /** 折进 `…` 的中间各级；为空时不显示 `…`。 */
  hidden: Crumb[];
  /** 末尾保留的几级，最后一项就是当前目录。 */
  tail: Crumb[];
};

/**
 * 把完整层级折成「根 + `…` + 末尾 `tailSize` 级」。层级本来就不多时不折：
 * 中间只剩一级还去换成一个 `…` 反而多一次点击，也不省地方。
 */
export function collapseCrumbs(
  crumbs: readonly Crumb[],
  tailSize: number = DEFAULT_TAIL,
): CollapsedCrumbs {
  // `breadcrumbs` 永远至少给出根那一格；空数组只可能来自调用方手搓，兜一下
  // 而不是让整行崩掉。
  const root = crumbs[0] ?? { label: "", path: "." };
  const rest = crumbs.slice(1);
  const keep = Math.max(1, tailSize);
  if (rest.length <= keep + 1) {
    return { root, hidden: [], tail: rest };
  }
  return {
    root,
    hidden: rest.slice(0, rest.length - keep),
    tail: rest.slice(rest.length - keep),
  };
}
