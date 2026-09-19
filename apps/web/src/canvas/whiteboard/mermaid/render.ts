import { loadMermaid, toParseError } from "./parse";

/**
 * Mermaid → SVG（[Mermaid 导入](../../../../../../docs/design/mermaid-import.md) §3.2）。
 *
 * 两处用它：对话框右边的预览，以及非 flowchart 图种的图片回退。
 *
 * 渲染要真 DOM（要量 `getBBox`），所以 jsdom 里跑不了——单测一律 `vi.mock`
 * 这个模块，只断言调用契约（设计 §7）。
 *
 * 安全（设计 §5）：`securityLevel: "strict"` 与 `htmlLabels: false` 在
 * `loadMermaid()` 里每次都设一遍，Mermaid 自己会剥掉标签里的 HTML 并禁用
 * `click` 指令；容器离屏、用完即弃；`bindFunctions` 从不调用，所以图文本
 * 里的任何回调都不会被接上。
 */

/** 离屏容器：不可见，但仍在文档里（`getBBox` 对脱离文档的节点返回 0）。 */
function createHost(): HTMLDivElement {
  const host = document.createElement("div");
  host.setAttribute("aria-hidden", "true");
  host.style.position = "absolute";
  host.style.left = "-10000px";
  host.style.top = "0";
  host.style.width = "1200px";
  host.style.pointerEvents = "none";
  document.body.append(host);
  return host;
}

let counter = 0;

/**
 * 渲染一次，返回 SVG 字符串。
 *
 * id 必须每次不同：Mermaid 拿它当 DOM id，重复会让上一次的残留把这一次的
 * 度量带偏。
 */
export async function renderMermaidSvg(text: string): Promise<string> {
  const mermaid = await loadMermaid();
  const host = createHost();
  const id = `armadra-mermaid-${(counter += 1)}`;
  try {
    const result = await (
      mermaid as unknown as {
        render: (
          id: string,
          text: string,
          container?: Element,
        ) => Promise<{ svg: string }>;
      }
    ).render(id, text, host);
    return result.svg;
  } catch (cause) {
    throw toParseError(cause);
  } finally {
    host.remove();
    // Mermaid 会在 body 上留一个 `d<id>` 的临时节点，自己收掉。
    document.getElementById(`d${id}`)?.remove();
  }
}

/** SVG 字符串 → 可交给资产导入路径的文件（落地前会被栅格化成 PNG）。 */
export function svgToFile(svg: string, name: string): File {
  return new File([svg], `${name}.svg`, { type: "image/svg+xml" });
}
