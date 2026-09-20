import { create } from "zustand";

import { requestOverlay } from "@/app/overlay-gates";
import type { ApplyLanguageEditResult } from "@armadra/shared";

import type { EditPreview } from "./edit-preview";

/**
 * 预览对话框的状态（语言服务设计 §2.6）。
 *
 * 对话框挂在应用壳里而不是编辑器节点里：一次重命名会改到别的文件，弹窗
 * 属于工作空间，不属于触发它的那个节点——节点被关掉时对话框也不该消失。
 */
interface EditPreviewState {
  preview: EditPreview | null;
  /** 正在算预览（要逐文件读正文）。 */
  loading: boolean;
  /** 应用之后的结果；保留在对话框里，用户可以看到写了哪些、哪些没写成。 */
  result: ApplyLanguageEditResult | null;
  /** 应用失败时 Runtime 给的那句话。 */
  error: string | null;
  applying: boolean;
  begin: () => void;
  show: (preview: EditPreview) => void;
  fail: (message: string) => void;
  setApplying: (applying: boolean) => void;
  finish: (result: ApplyLanguageEditResult) => void;
  close: () => void;
}

export const useEditPreviewStore = create<EditPreviewState>()((set) => ({
  preview: null,
  loading: false,
  result: null,
  error: null,
  applying: false,
  begin: () => {
    // 对话框本身是 `React.lazy` 的，只有被渲染才会去取 chunk；闸门在这里开。
    requestOverlay("editPreview");
    set({ loading: true, preview: null, result: null, error: null });
  },
  show: (preview) => {
    requestOverlay("editPreview");
    set({ preview, loading: false });
  },
  fail: (message) => {
    requestOverlay("editPreview");
    set({ loading: false, applying: false, error: message });
  },
  setApplying: (applying) => set({ applying }),
  finish: (result) => set({ result, applying: false }),
  close: () =>
    set({
      preview: null,
      loading: false,
      result: null,
      error: null,
      applying: false,
    }),
}));
