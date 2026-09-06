// B5 重建：白板对象 → Agent 的内容引用（React Flow 计划 §2.5 / F29）。
//
// 旧引擎里这里从编辑器收集「一端绑节点、一端绑白板 shape」的箭头。
// 引用现在是 `whiteboard.references` 里的一行（§3.1），PNG 由自写的
// `whiteboard/raster.ts` 出，发布 / 缓存 / 重试的状态机原样保留。
//
// B0 只留下三样东西：`ContextLink` 的上限、纯文本辅助（Runtime 的字节口径
// 由它决定，与引用模型无关），以及一个恒返回空表的 `useContentLinks`。
// 这样 `context-links.ts`（推链接文档给 Runtime）照常工作，只是暂时没有
// 白板来源的链接。
import type { ContextLink } from "@armadra/shared";

import { t } from "@/app/preferences-store";

/** 栅格化 + 上传的防抖：连着改一笔不要每一帧都导出一次。 */
export const EXPORT_DELAY_MS = 2000;

/** 标题截断（文字对象取正文前 40 字）。 */
export const TITLE_MAX = 40;

/** `ContextLink.content.text` 的上限，与 Runtime 的校验同一个数。 */
export const MAX_CONTENT_TEXT_BYTES = 20_000;

/** 一个节点的链接文档最多 64 条（`contextLinksRequestSchema`）。 */
export const MAX_LINKS = 64;

/** 内容引用在链接文档里的 `kind`（Runtime 的 `collab/context_link.rs`）。 */
export const SHAPE_KIND = "shape";

/**
 * 白板对象类型 → 标题用的 i18n 键。
 *
 * `ContextLink.content.shapeType` 只是给用户看的提示，Runtime 不按它分支
 * （已核实 `read_shape` 只读 `text` / `png_path`）。
 */
export const CONTENT_TYPE_KEYS: Record<string, string> = {
  text: "content.text",
  shape: "content.geo",
  ink: "content.draw",
  image: "content.image",
  line: "content.line",
  group: "content.group",
};

/** 按字节截断（Runtime 校验的是字节数）。 */
export function clampText(
  text: string,
  limit = MAX_CONTENT_TEXT_BYTES,
): string {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= limit) return text;
  // 流式解码会留住不完整的尾部码点，而不是吐出无效代理对或替换字符。
  return new TextDecoder().decode(bytes.subarray(0, Math.max(0, limit)), {
    stream: true,
  });
}

/** 链接的标题：文字取正文前 40 字，其余取类型名。 */
export function contentTitle(
  kind: string,
  text: string,
  label: (key: string) => string = t,
): string {
  if (kind === "text") {
    const line = text.trim().replace(/\s+/gu, " ");
    if (line) {
      const chars = Array.from(line);
      return chars.length > TITLE_MAX
        ? `${clampText(chars.slice(0, TITLE_MAX).join(""), 157)}…`
        : clampText(line, 160);
    }
  }
  return label(CONTENT_TYPE_KEYS[kind] ?? "content.shape");
}

/** 终端节点 id → 它的内容引用。 */
export type ContentLinkMap = Record<string, ContextLink[]>;

const NO_LINKS: ContentLinkMap = {};

/** 显式重试，桌面与 Web 的右键菜单共用。 */
export const REFRESH_CONTENT_EVENT = "armadra:refresh-content-references";

export function refreshContentReferences(): void {
  window.dispatchEvent(new Event(REFRESH_CONTENT_EVENT));
}

/** B5 改成订阅 `whiteboard.references` 与 `items`。 */
export function useContentLinks(): ContentLinkMap {
  return NO_LINKS;
}
