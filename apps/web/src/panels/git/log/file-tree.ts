import type { GitCommitFile } from "@armadra/shared";

/**
 * 变更文件的目录分组（Git 工具窗口设计 §2.2 详情栏「按目录分组，可切平铺」）。
 *
 * 纯函数，所以「一个只有一层的目录会不会多出一行」这类事能被测试钉住：
 * 只有一个子项的目录段与它下面的段**合并**成 `apps/web/src`，IDEA 与
 * VS Code 都这么做——每一层都单独占一行会让一条深路径吃掉半个面板。
 *
 * 重命名的两端由 `path` 里的 `旧 -> 新` 携带（Git 的 `--name-status` 格式），
 * 这里拆开，行上两端都显示：只显示新名字的话，一次重命名看起来像是凭空多出
 * 一个文件，而旧的那个悄悄不见了。
 */

export interface FileRow {
  kind: "directory" | "file";
  /** 显示的文字：目录是合并后的段，文件是它的基名（平铺时是整条路径）。 */
  label: string;
  /** 完整路径；目录行是它的前缀。 */
  path: string;
  depth: number;
  file?: GitCommitFile;
  /** 重命名的来源；只有 `R` 状态才有。 */
  renamedFrom?: string;
  /** 目录行下有几个文件。 */
  count?: number;
}

/** `R100\told -> new`：Git 把两端写在同一个字段里。 */
export function splitRename(path: string): {
  path: string;
  renamedFrom?: string;
} {
  const arrow = path.indexOf(" -> ");
  if (arrow < 0) return { path };
  return {
    renamedFrom: path.slice(0, arrow),
    path: path.slice(arrow + 4),
  };
}

interface Node {
  segment: string;
  children: Map<string, Node>;
  files: { file: GitCommitFile; name: string; renamedFrom?: string }[];
}

function emptyNode(segment: string): Node {
  return { segment, children: new Map(), files: [] };
}

export function buildFileRows(
  files: readonly GitCommitFile[],
  flat: boolean,
): FileRow[] {
  if (flat) {
    return files.map((file) => {
      const { path, renamedFrom } = splitRename(file.path);
      return {
        kind: "file" as const,
        label: path,
        path,
        depth: 0,
        file,
        renamedFrom,
      };
    });
  }
  const root = emptyNode("");
  for (const file of files) {
    const { path, renamedFrom } = splitRename(file.path);
    const segments = path.split("/");
    const name = segments.pop() ?? path;
    let node = root;
    for (const segment of segments) {
      let next = node.children.get(segment);
      if (!next) {
        next = emptyNode(segment);
        node.children.set(segment, next);
      }
      node = next;
    }
    node.files.push({ file, name, renamedFrom });
  }
  const rows: FileRow[] = [];
  const walk = (node: Node, prefix: string, depth: number) => {
    for (const child of [...node.children.values()].sort((left, right) =>
      left.segment.localeCompare(right.segment),
    )) {
      // 只有一条路可走的目录段一路合并：`apps` → `apps/web/src`。
      let label = child.segment;
      let current = child;
      while (current.files.length === 0 && current.children.size === 1) {
        const only = [...current.children.values()][0]!;
        label = `${label}/${only.segment}`;
        current = only;
      }
      const path = prefix === "" ? label : `${prefix}/${label}`;
      rows.push({
        kind: "directory",
        label,
        path,
        depth,
        count: countFiles(current),
      });
      walk(current, path, depth + 1);
    }
    for (const entry of [...node.files].sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      rows.push({
        kind: "file",
        label: entry.name,
        path: prefix === "" ? entry.name : `${prefix}/${entry.name}`,
        depth,
        file: entry.file,
        renamedFrom: entry.renamedFrom,
      });
    }
  };
  walk(root, "", 0);
  return rows;
}

function countFiles(node: Node): number {
  return (
    node.files.length +
    [...node.children.values()].reduce(
      (total, child) => total + countFiles(child),
      0,
    )
  );
}
