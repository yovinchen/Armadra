import type { GitRefsBranch, GitRefsRepository } from "./types";

/**
 * 左栏分支树的构造（Git 工具窗口设计 §2.2「分支树」）。
 *
 * 纯函数，没有 React、没有 i18n：树是数据，画树才是组件的事。四件容易做错的
 * 事都收在这里，所以能被单测钉死：
 *
 * 1. **`/` 分段折叠**。`feat/foo` 与 `feat/bar` 折进同一个 `feat`；只有一条
 *    分支的段不折——`main` 不该变成一个里面只有 `main` 的文件夹。
 * 2. **收藏置顶**。星标的分支排在同层最前，其余按名字排；置顶发生在**每一
 *    层**，而不是把收藏拎出树外另开一组，否则 `feat/foo` 收藏之后就找不到它
 *    的兄弟了。
 * 3. **过滤保留祖先**。叶子命中时，从它到仓库根的每一层都要留下来，否则命中
 *    的分支会挂在一棵不存在的树上。
 * 4. **身份**。节点 id 里带仓库路径：两个仓库都有 `main`，展开一个不该同时
 *    展开另一个。
 */

export type BranchTreeKind =
  | "head"
  | "repository"
  | "group"
  | "remote"
  | "segment"
  | "branch"
  | "tag"
  | "worktree"
  | "stash";

/** 仓库根下固定的四组，Stash 有条目时出现第五组。 */
export type BranchTreeGroup =
  | "local"
  | "remotes"
  | "tags"
  | "worktrees"
  | "stashes";

export interface BranchTreeNode {
  /** 展开状态与选中都按它；仓库路径已经在里面，跨仓库不会串。 */
  id: string;
  kind: BranchTreeKind;
  /** 这一层显示的文字：分段折叠后只是最后一段。 */
  label: string;
  /** 这个节点属于哪个仓库；`HEAD` 顶节点是 `null`（它跨全部仓库）。 */
  repositoryPath: string | null;
  /**
   * 选中这个节点时日志要看的引用；没有引用的节点（组、段）是 `null`，
   * 仓库根是 `null` 但 `kind` 说明「这个仓库的全部分支」。
   */
  reference: string | null;
  /** 固定组的身份，只有 `kind === "group"` 时有。 */
  group?: BranchTreeGroup;
  /**
   * 分支节点观察到的对象 ID。写动作（检出、删除）拿它当期望值，所以它必须
   * 是**这一次读回来的那个**，不是稍后再查一次的那个。
   */
  oid?: string;
  current?: boolean;
  favorite?: boolean;
  ahead?: number | null;
  behind?: number | null;
  /** Stash 组的条目数、仓库根的颜色序号这类附带数字。 */
  count?: number;
  /** 仓库根的调色板序号，与提交表左侧的颜色条同一套。 */
  color?: number;
  children: BranchTreeNode[];
}

/**
 * 选中集合与收藏集合共用的键：一个仓库里的一个引用。
 *
 * 分隔符是 NUL，不是斜杠也不是空格：仓库路径里可以有空格，分支名里可以有
 * 斜杠，只有 NUL 是 Git 的引用名和路径都不可能出现的字节。
 */
export const REF_SEPARATOR = "\u0000";

/** 选中集合与收藏集合共用的键：一个仓库里的一个引用。 */
export function refKey(repositoryPath: string, reference: string): string {
  return `${repositoryPath}${REF_SEPARATOR}${reference}`;
}

export interface BuildTreeOptions {
  /** 收藏的引用键（`refKey`）。 */
  favorites?: readonly string[];
  /** 过滤输入；空串 = 不过滤。大小写不敏感的子串匹配。 */
  filter?: string;
  /** 仓库路径 → 调色板序号，与日志响应里的 `repositories[].color` 同一份。 */
  colors?: ReadonlyMap<string, number>;
}

const GROUP_ORDER: BranchTreeGroup[] = [
  "local",
  "remotes",
  "tags",
  "worktrees",
  "stashes",
];

/** 顶部的 `HEAD` 节点：所有仓库的默认视图，也是「引用日志…」的入口。 */
export const HEAD_NODE_ID = "head";

function matches(value: string, filter: string) {
  return filter === "" || value.toLowerCase().includes(filter);
}

/**
 * 把一组分支按 `/` 折成子树。
 *
 * `prefix` 是 id 前缀，`base` 是已经吃掉的名字段——叶子的 `reference` 要的是
 * **完整分支名**，不是最后一段。
 */
function segmentBranches(
  prefix: string,
  repositoryPath: string,
  branches: readonly { name: string; branch: GitRefsBranch }[],
  favorites: ReadonlySet<string>,
): BranchTreeNode[] {
  const leaves: BranchTreeNode[] = [];
  const groups = new Map<string, { name: string; branch: GitRefsBranch }[]>();
  for (const entry of branches) {
    const slash = entry.name.indexOf("/");
    if (slash <= 0) {
      leaves.push(branchNode(prefix, repositoryPath, entry, favorites));
      continue;
    }
    const head = entry.name.slice(0, slash);
    const rest = entry.name.slice(slash + 1);
    const bucket = groups.get(head) ?? [];
    bucket.push({ name: rest, branch: entry.branch });
    groups.set(head, bucket);
  }
  const nodes: BranchTreeNode[] = [...leaves];
  for (const [head, bucket] of groups) {
    // 只有一条分支的段不折：`release/1.0` 独自一条时展开一层文件夹只是多一次点击。
    if (bucket.length === 1) {
      const only = bucket[0]!;
      nodes.push(
        branchNode(
          prefix,
          repositoryPath,
          { name: `${head}/${only.name}`, branch: only.branch },
          favorites,
        ),
      );
      continue;
    }
    const id = `${prefix}/${head}`;
    const children = segmentBranches(id, repositoryPath, bucket, favorites);
    nodes.push({
      id,
      kind: "segment",
      label: head,
      repositoryPath,
      reference: null,
      children,
    });
  }
  return sortNodes(nodes);
}

function branchNode(
  prefix: string,
  repositoryPath: string,
  entry: { name: string; branch: GitRefsBranch },
  favorites: ReadonlySet<string>,
): BranchTreeNode {
  const reference = entry.branch.name;
  return {
    id: `${prefix}/${entry.name}`,
    kind: "branch",
    label: entry.name,
    repositoryPath,
    reference,
    oid: entry.branch.oid,
    current: entry.branch.current,
    favorite: favorites.has(refKey(repositoryPath, reference)),
    ahead: entry.branch.ahead,
    behind: entry.branch.behind,
    children: [],
  };
}

/** 收藏在前，其余按名字；段与叶子混排时段排在叶子后面。 */
function sortNodes(nodes: BranchTreeNode[]): BranchTreeNode[] {
  return [...nodes].sort((left, right) => {
    if (Boolean(left.favorite) !== Boolean(right.favorite))
      return left.favorite ? -1 : 1;
    if ((left.kind === "segment") !== (right.kind === "segment"))
      return left.kind === "segment" ? 1 : -1;
    return left.label.localeCompare(right.label);
  });
}

/** 过滤：叶子按标签匹配，容器只要有后代活下来就活下来。 */
function prune(node: BranchTreeNode, filter: string): BranchTreeNode | null {
  if (filter === "") return node;
  const children = node.children
    .map((child) => prune(child, filter))
    .filter((child): child is BranchTreeNode => child !== null);
  if (children.length > 0) return { ...node, children };
  // 容器自己的名字也能命中（`本地`、远端名、仓库名）。
  const own =
    node.kind === "branch" || node.kind === "tag" || node.kind === "worktree"
      ? (node.reference ?? node.label)
      : node.label;
  return matches(own, filter) && node.children.length === 0
    ? { ...node, children: [] }
    : null;
}

export function buildBranchTree(
  repositories: readonly GitRefsRepository[],
  options: BuildTreeOptions = {},
): BranchTreeNode[] {
  const favorites = new Set(options.favorites ?? []);
  const filter = (options.filter ?? "").trim().toLowerCase();
  const colors = options.colors;
  const roots: BranchTreeNode[] = [
    {
      id: HEAD_NODE_ID,
      kind: "head",
      label: "HEAD",
      repositoryPath: null,
      reference: "HEAD",
      children: [],
    },
  ];
  for (const repository of repositories) {
    const path = repository.repositoryPath;
    const groups: BranchTreeNode[] = [];
    const groupNode = (
      group: BranchTreeGroup,
      children: BranchTreeNode[],
      count?: number,
    ): BranchTreeNode => ({
      id: `${path}::${group}`,
      kind: "group",
      group,
      label: group,
      repositoryPath: path,
      reference: null,
      count,
      children,
    });

    groups.push(
      groupNode(
        "local",
        segmentBranches(
          `${path}::local`,
          path,
          repository.branches.map((branch) => ({
            name: branch.name,
            branch,
          })),
          favorites,
        ),
      ),
    );

    groups.push(
      groupNode(
        "remotes",
        repository.remotes.map((remote) => ({
          id: `${path}::remote::${remote.name}`,
          kind: "remote" as const,
          label: remote.name,
          repositoryPath: path,
          reference: null,
          children: segmentBranches(
            `${path}::remote::${remote.name}`,
            path,
            remote.branches.map((branch) => ({
              // 远端分支在树上按 `remote/branch` 显示，但引用名照旧是完整的。
              name: branch.name.startsWith(`${remote.name}/`)
                ? branch.name.slice(remote.name.length + 1)
                : branch.name,
              branch,
            })),
            favorites,
          ),
        })),
      ),
    );

    groups.push(
      groupNode(
        "tags",
        sortNodes(
          repository.tags.map((tag) => ({
            id: `${path}::tag::${tag}`,
            kind: "tag" as const,
            label: tag,
            repositoryPath: path,
            reference: tag,
            favorite: favorites.has(refKey(path, tag)),
            children: [],
          })),
        ),
      ),
    );

    groups.push(
      groupNode(
        "worktrees",
        repository.worktrees.map((worktree) => ({
          id: `${path}::worktree::${worktree.path}`,
          kind: "worktree" as const,
          label: worktree.path,
          repositoryPath: path,
          // worktree 节点选中时看它检出的那条分支；分离时没有引用可看。
          reference: worktree.branch,
          current: worktree.isMain,
          children: [],
        })),
      ),
    );

    // Stash 只在有条目时出现——一个永远空着的组只是噪音。
    if (repository.stashCount > 0) {
      groups.push(
        groupNode(
          "stashes",
          [
            {
              id: `${path}::stash::list`,
              kind: "stash" as const,
              label: String(repository.stashCount),
              repositoryPath: path,
              reference: null,
              count: repository.stashCount,
              children: [],
            },
          ],
          repository.stashCount,
        ),
      );
    }

    const ordered = GROUP_ORDER.map((group) =>
      groups.find((node) => node.group === group),
    ).filter((node): node is BranchTreeNode => node !== undefined);

    roots.push({
      id: `${path}::root`,
      kind: "repository",
      label: repository.name,
      repositoryPath: path,
      reference: null,
      current: repository.head !== null,
      color: colors?.get(path),
      children: ordered,
    });
  }
  if (filter === "") return roots;
  return roots
    .map((root) => (root.kind === "head" ? root : prune(root, filter)))
    .filter((root): root is BranchTreeNode => root !== null);
}

export interface FlatTreeRow {
  node: BranchTreeNode;
  depth: number;
  expandable: boolean;
  expanded: boolean;
}

/** 展开状态铺平成可渲染的行。缺省展开仓库根与 `本地` 组。 */
export function flattenTree(
  nodes: readonly BranchTreeNode[],
  expanded: ReadonlySet<string>,
): FlatTreeRow[] {
  const rows: FlatTreeRow[] = [];
  const walk = (node: BranchTreeNode, depth: number) => {
    const expandable = node.children.length > 0;
    const open = expandable && expanded.has(node.id);
    rows.push({ node, depth, expandable, expanded: open });
    if (open) for (const child of node.children) walk(child, depth + 1);
  };
  for (const node of nodes) walk(node, 0);
  return rows;
}

/** 第一次打开时默认展开的节点：每个仓库根和它的 `本地` 组。 */
export function defaultExpanded(
  repositories: readonly GitRefsRepository[],
): string[] {
  return repositories.flatMap((repository) => [
    `${repository.repositoryPath}::root`,
    `${repository.repositoryPath}::local`,
  ]);
}
