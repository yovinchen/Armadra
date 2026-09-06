/**
 * 语言服务里**依赖 `@codemirror/lsp-client` 的那一半**（设计 §2.4 结尾）。
 *
 * 单独一个模块，只被 `use-language.ts` 动态 `import()`。理由与语法高亮包
 * 一样：`EditorNode` 是画布节点注册表的静态成员，从它静态引一次 lsp-client
 * 就等于把 LSP 客户端与 `marked` 压进启动路径，而绝大多数会话根本不会打开
 * 编辑器（§6.1 第 13 条：未打开编辑器不加载）。
 *
 * 不依赖 lsp-client 的那一半（uri、语言表、诊断 store、状态 store、预览
 * 模型）照常静态引用——问题面板与设置页要用它们，而它们不该拖着一个 LSP
 * 客户端。
 */
export {
  acquireLanguageClient,
  peekLanguageClient,
  resetLanguageClients,
  type LanguageClient,
} from "./client";
export { languageEditorExtensions } from "./extensions";
export { formatDocumentAndWait, renameWithPreview } from "./commands";
export { ArmadraWorkspace, type Ownership } from "./documents";
