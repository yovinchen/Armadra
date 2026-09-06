import { create } from "zustand";

/**
 * 工作空间范围的诊断（语言服务设计 §4.2 `diagnostics-store.ts`）。
 *
 * 编辑器里的行内标记由 `@codemirror/lsp-client` 的 `serverDiagnostics()` 自己
 * 画——它拿的是同一条 `publishDiagnostics`。这个 store 存在的理由只有一个：
 * 问题面板要看**没有打开的文件**的诊断，而 CodeMirror 的 lint 状态只活在
 * 一个 `EditorView` 里。
 *
 * 三条约束：
 *  * 键是 `armadra:///<rel>`，不是路径——server 说的就是 uri。
 *  * 空数组和「没有这一项」是同一件事：server 修好一个文件时推的正是空数组，
 *    留一个空条目会让面板显示一个永远为 0 的文件行。
 *  * 会话关掉、断线、失去授权时整片清空。留着上一次的诊断等于对着一份可能
 *    已经改过的文件显示结论。
 */

/** LSP `Diagnostic` 里面板用得上的那几个字段。 */
export interface Diagnostic {
  /** 0 起的行列，与 LSP 一致；跳转时再 +1。 */
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  /** LSP 的 1=Error 2=Warning 3=Information 4=Hint；缺席按 Error 处理。 */
  severity?: number;
  code?: string | number;
  source?: string;
  message: string;
}

export type DiagnosticSeverity = "error" | "warning" | "info" | "hint";

export function severityOf(diagnostic: Diagnostic): DiagnosticSeverity {
  switch (diagnostic.severity) {
    case 2:
      return "warning";
    case 3:
      return "info";
    case 4:
      return "hint";
    default:
      return "error";
  }
}

interface DiagnosticsState {
  /** uri → 该文件当前的全部诊断。 */
  byUri: Record<string, Diagnostic[]>;
  /** 一次 `publishDiagnostics`：空数组就把这一项删掉。 */
  publish: (uri: string, diagnostics: Diagnostic[]) => void;
  /** 一个会话结束：把它开过的文件的诊断清掉。 */
  clear: (uris?: string[]) => void;
}

export const useDiagnosticsStore = create<DiagnosticsState>()((set) => ({
  byUri: {},
  publish: (uri, diagnostics) =>
    set((state) => {
      if (diagnostics.length === 0) {
        if (!(uri in state.byUri)) return state;
        const { [uri]: _removed, ...rest } = state.byUri;
        return { byUri: rest };
      }
      return { byUri: { ...state.byUri, [uri]: diagnostics } };
    }),
  clear: (uris) =>
    set((state) => {
      if (!uris) return { byUri: {} };
      const next = { ...state.byUri };
      for (const uri of uris) delete next[uri];
      return { byUri: next };
    }),
}));

/** 一份按 uri 分组、按严重度排序的快照，面板与状态栏共用。 */
export interface DiagnosticGroup {
  uri: string;
  diagnostics: Diagnostic[];
  errors: number;
  warnings: number;
}

const SEVERITY_ORDER: Record<DiagnosticSeverity, number> = {
  error: 0,
  warning: 1,
  info: 2,
  hint: 3,
};

export function groupDiagnostics(
  byUri: Record<string, Diagnostic[]>,
): DiagnosticGroup[] {
  return (
    Object.entries(byUri)
      .map(([uri, diagnostics]) => ({
        uri,
        diagnostics: [...diagnostics].sort(
          (left, right) =>
            SEVERITY_ORDER[severityOf(left)] -
              SEVERITY_ORDER[severityOf(right)] ||
            left.range.start.line - right.range.start.line ||
            left.range.start.character - right.range.start.character,
        ),
        errors: diagnostics.filter((entry) => severityOf(entry) === "error")
          .length,
        warnings: diagnostics.filter((entry) => severityOf(entry) === "warning")
          .length,
      }))
      // 有错的文件排前面，其余按路径，这样刷新一次诊断列表不会整片重排。
      .sort(
        (left, right) =>
          Number(right.errors > 0) - Number(left.errors > 0) ||
          left.uri.localeCompare(right.uri),
      )
  );
}

/** 面板标题上的两个数字。 */
export function countDiagnostics(byUri: Record<string, Diagnostic[]>): {
  errors: number;
  warnings: number;
} {
  let errors = 0;
  let warnings = 0;
  for (const diagnostics of Object.values(byUri)) {
    for (const diagnostic of diagnostics) {
      const severity = severityOf(diagnostic);
      if (severity === "error") errors += 1;
      else if (severity === "warning") warnings += 1;
    }
  }
  return { errors, warnings };
}
