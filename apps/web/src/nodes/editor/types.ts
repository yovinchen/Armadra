import type {
  FileChangeKind,
  FileEncoding,
  FileEol,
  ImportedFileInfo,
} from "@armadra/shared";

export type LoadState =
  | { kind: "loading" }
  | { kind: "error" }
  | { kind: "too-large" }
  | { kind: "media"; media: MediaKind; src: string; info: ImportedFileInfo }
  | { kind: "attachment"; info: ImportedFileInfo }
  | {
      kind: "text";
      content: string;
      size: number;
      sha256?: string;
      identity: string;
      /** Runtime 探到的编码 / BOM / 换行（E01/M4）；旧 Runtime 不给。 */
      encoding?: FileEncoding;
      bom?: boolean;
      eol?: FileEol;
      /** 文件本身不可写，与工作区权限无关。 */
      readonly?: boolean;
    };

/** 由页面自己渲染的非文本预览（`file-info` 的 `preview`）。 */
export type MediaKind = "image" | "video" | "audio" | "pdf";

/** 编辑区显示什么：正文、并排、纯预览。仅 Markdown 用得上。 */
export type ViewMode = "edit" | "split" | "preview";

/**
 * 磁盘上这个文件的最新状态（E01/M4）。
 * `sha256` 为空表示文件已不在（`kind === "removed"`）。
 */
export interface ExternalChange {
  kind: FileChangeKind;
  sha256?: string;
}
