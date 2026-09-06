import { create } from "zustand";

import type { Choice, MergeRegion } from "@/lib/merge3";

/**
 * 三方合并视图的状态（编辑器设计 §3「外部变化规则」、Git 冲突中心）。
 *
 * 它挂在应用壳上而不是某个编辑器节点里，理由和预览对话框一样：合并要读
 * Git 索引里的三份 blob、要写盘、要调「标记已解决」，这些都不随一个节点
 * 被关掉而失去意义。
 */

export interface MergeState {
  open: boolean;
  workspaceId: string | null;
  path: string | null;
  loading: boolean;
  /** 打不开合并视图的原因（不是冲突文件、是二进制、正文被截断…）。 */
  unavailable: string | null;
  regions: MergeRegion[];
  /** 每个冲突段选了哪一侧，下标就是第几个冲突段。 */
  choices: Choice[];
  /** 打开时读到的内容版本，写盘时原样送回去。 */
  expectedSha256: string | null;
  /** 文件原本有 BOM，写回时要补上。 */
  bom: boolean;
  /** 原文件末尾有换行；合并结果保持一致。 */
  trailingNewline: boolean;
  saving: boolean;
  /** 写盘或「标记已解决」的失败信息，原样显示——它带着行号。 */
  error: string | null;
  /** 已经写盘并且索引里标了已解决。 */
  resolved: boolean;
  begin: (context: { workspaceId: string; path: string }) => void;
  ready: (loaded: {
    regions: MergeRegion[];
    expectedSha256: string | null;
    bom: boolean;
    trailingNewline: boolean;
  }) => void;
  refuse: (reason: string) => void;
  choose: (index: number, choice: Choice) => void;
  setSaving: (saving: boolean) => void;
  fail: (message: string) => void;
  finish: () => void;
  close: () => void;
}

type MergeData = Omit<
  MergeState,
  | "begin"
  | "ready"
  | "refuse"
  | "choose"
  | "setSaving"
  | "fail"
  | "finish"
  | "close"
>;

function empty(): MergeData {
  return {
    open: false,
    workspaceId: null,
    path: null,
    loading: false,
    unavailable: null,
    regions: [],
    choices: [],
    expectedSha256: null,
    bom: false,
    trailingNewline: true,
    saving: false,
    error: null,
    resolved: false,
  };
}

export const useMergeStore = create<MergeState>()((set) => ({
  ...empty(),
  begin: ({ workspaceId, path }) =>
    set({ ...empty(), open: true, loading: true, workspaceId, path }),
  ready: ({ regions, expectedSha256, bom, trailingNewline }) =>
    set({
      loading: false,
      regions,
      // 默认全部取「我们的」：那是工作区当前分支上的东西，也是不做任何选择
      // 时最不意外的一侧。每一处仍然要人自己确认。
      choices: regions
        .filter((region) => region.kind === "conflict")
        .map((): Choice => "ours"),
      expectedSha256,
      bom,
      trailingNewline,
    }),
  refuse: (reason) => set({ loading: false, unavailable: reason }),
  choose: (index, choice) =>
    set((state) => {
      const choices = [...state.choices];
      choices[index] = choice;
      return { choices, resolved: false };
    }),
  setSaving: (saving) => set({ saving, error: null }),
  fail: (message) => set({ saving: false, error: message }),
  finish: () => set({ saving: false, error: null, resolved: true }),
  close: () => set({ ...empty() }),
}));
