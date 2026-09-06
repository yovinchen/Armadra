import { create } from "zustand";

/**
 * 「查找引用」的结果（语言服务设计 §1.1、§4.2 `ReferencesPanel.tsx`）。
 *
 * 它是一个 store 而不是编辑器里的一块浮层，因为引用几乎总是跨文件的：
 * `@codemirror/lsp-client` 自带的面板贴在触发它的那个 `EditorView` 上，
 * 点一条跳到别的文件时面板就跟着那个视图一起消失了。结果属于工作空间，
 * 不属于问出这个问题的那个节点。
 *
 * 只保留一次查询。第二次查找引用替换第一次的结果：两份并存的列表里，
 * 上面那份是对着哪一版正文算的没人说得清。
 */

/** 一条引用的位置，行列都是 0 起（与 LSP 一致），跳转时再 +1。 */
export interface ReferenceLocation {
  line: number;
  character: number;
  /** 该行正文（去掉首尾空白）。取不到正文时缺席，不写空串。 */
  preview?: string;
}

export interface ReferenceGroup {
  /** `armadra:///<rel>`；工作空间之外的位置不会进来。 */
  uri: string;
  path: string;
  locations: ReferenceLocation[];
}

interface ReferencesState {
  /** 查的是哪个符号，用于标题；取不到词时是空串。 */
  symbol: string;
  loading: boolean;
  error: string | null;
  groups: ReferenceGroup[];
  /** 折叠起来的文件；默认全部展开，所以这里存的是「收起了的」。 */
  collapsed: Record<string, boolean>;
  /** 工作空间之外、面板不打开的那些位置有多少条。列出来比省略诚实。 */
  external: number;
  begin: (symbol: string) => void;
  show: (groups: ReferenceGroup[], external: number) => void;
  fail: (message: string) => void;
  toggle: (uri: string) => void;
  clear: () => void;
}

export const useReferencesStore = create<ReferencesState>()((set) => ({
  symbol: "",
  loading: false,
  error: null,
  groups: [],
  collapsed: {},
  external: 0,
  begin: (symbol) =>
    set({
      symbol,
      loading: true,
      error: null,
      groups: [],
      collapsed: {},
      external: 0,
    }),
  show: (groups, external) => set({ groups, external, loading: false }),
  fail: (message) => set({ loading: false, error: message, groups: [] }),
  toggle: (uri) =>
    set((state) => ({
      collapsed: { ...state.collapsed, [uri]: !state.collapsed[uri] },
    })),
  clear: () =>
    set({
      symbol: "",
      loading: false,
      error: null,
      groups: [],
      collapsed: {},
      external: 0,
    }),
}));

/** 面板标题上的计数。 */
export function countReferences(groups: ReferenceGroup[]): number {
  return groups.reduce((total, group) => total + group.locations.length, 0);
}
