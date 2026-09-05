import type { Editor, TLShape, TLShapeId } from "tldraw";

/**
 * 停用 tldraw 的四种原生 shape（计划 §4.5）。
 *
 * - `note`：便签是我们的 `armadra:sticky`——Agent 的控制动词 `sticky` 要写
 *   `nodes` 表，而 Runtime 不解析白板快照。两种便签并存只会让人分不清
 *   哪个 Agent 读得到。
 * - `bookmark` / `embed`：需要抓取远端网页的 og 信息，离线的桌面壳里只会
 *   显示一块空白；粘贴 URL 改成落一段文字（`dnd/external-content.ts`）。
 * - `video`：没有对应的资产类型（`ASSET_MIME_TYPES` 只有 8 种图片），
 *   拖进来的视频文件在 `files` 处理器里已经被当成文本了。
 *
 * **为什么还要一道运行时守卫**：`<Tldraw>` 内部用
 * `mergeArraysAndReplaceDefaults` 把 `defaultShapeUtils` 无条件合回来
 * （同名的才会被替换），所以传一份过滤过的 `shapeUtils` 只是把意图写清楚，
 * 拦不住创建。真正拦得住的是这里——而且必须拦：从别的 tldraw 页面复制一
 * 张便签过来是 `putExternalContent({ type: "tldraw" })`，那条路不经过我们
 * 覆盖的任何一个处理器。
 *
 * 反过来，**schema 里不能少了它们**：老看板的快照里可能真的存着一个
 * `note`，shapeUtil 缺席时 `loadSnapshot` 会整份失败。所以停用只发生在
 * 「创建」这一刻，读旧数据照旧。
 */
export const RETIRED_SHAPE_TYPES = [
  "note",
  "bookmark",
  "embed",
  "video",
] as const;

export type RetiredShapeType = (typeof RETIRED_SHAPE_TYPES)[number];

const RETIRED = new Set<string>(RETIRED_SHAPE_TYPES);

export function isRetiredShapeType(type: string): boolean {
  return RETIRED.has(type);
}

/**
 * 停用之后画布上还剩哪些 shape 工具（Dock 的工具表 `canvas/tools.ts` 自己
 * 就只列了留下的那些，这里给单测一个可断言的清单）。
 */
export function activeShapeUtils<T extends { type: string }>(
  utils: readonly T[],
): T[] {
  return utils.filter((util) => !RETIRED.has(util.type));
}

/**
 * 装一道创建守卫，返回注销函数。`TldrawWorkspace.onMount` 调一次。
 *
 * 删除推到微任务里做：after-create 还在 store 的那次事务里，就地删会把
 * 同一批记录的处理搅乱（`shapes/LinkArrow.ts` 的换形也是这个理由）。
 */
export function registerRetiredShapes(editor: Editor): () => void {
  let disposed = false;
  const doomed = new Set<TLShapeId>();

  const sweep = () => {
    if (disposed || doomed.size === 0) return;
    const ids = [...doomed].filter((id) => editor.getShape(id));
    doomed.clear();
    if (ids.length === 0) return;
    // 不进撤销栈：用户没做过这一步，⌘Z 不该把便签「撤」回来。
    editor.run(() => editor.deleteShapes(ids), { history: "ignore" });
  };

  const off = editor.sideEffects.registerAfterCreateHandler(
    "shape",
    (shape: TLShape, source: string) => {
      if (source !== "user" || !RETIRED.has(shape.type)) return;
      doomed.add(shape.id);
      queueMicrotask(sweep);
    },
  );

  return () => {
    disposed = true;
    off();
  };
}
