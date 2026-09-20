/**
 * 扩展名 → LSP `languageId`（语言服务设计 §1.2、§4.2）。
 *
 * 这张表必须和 合并前实现的
 * `LANGUAGES` / `FILE_NAMES` 逐条对上：Runtime 按 languageId 找 server，
 * Web 按同一个 id 开会话，两边不一致就是「打开了一个永远不会有诊断的会话」。
 * `language-ids.test.ts` 直接读那份 Rust 常量做比对。
 */

/** 一种语言覆盖哪些扩展名。顺序即 Rust 表的顺序，方便逐行对照。 */
export const LANGUAGE_EXTENSIONS: ReadonlyArray<
  readonly [languageId: string, extensions: readonly string[]]
> = [
  ["typescript", ["ts", "tsx", "mts", "cts"]],
  ["javascript", ["js", "jsx", "mjs", "cjs"]],
  ["rust", ["rs"]],
  ["go", ["go"]],
  ["python", ["py", "pyi"]],
  ["json", ["json", "jsonc"]],
  ["yaml", ["yaml", "yml"]],
  ["markdown", ["md", "markdown"]],
];

/**
 * 整个文件名就说明了语言的那几个。没有这几条，`go.mod` 会被当成扩展名
 * `mod`，结果是没有语言。
 */
export const LANGUAGE_FILE_NAMES: ReadonlyArray<
  readonly [fileName: string, languageId: string]
> = [
  ["go.mod", "go"],
  ["go.sum", "go"],
  ["go.work", "go"],
];

/**
 * 一条路径的 languageId，认不出来就是 `null`。
 *
 * `null` 是一个答案：编辑器照常打开文件，只是不开语言会话——不为一个
 * server 看不懂的文件去启动它。
 */
export function languageIdFor(path: string): string | null {
  const name = path.split(/[\\/]/).pop() ?? path;
  const named = LANGUAGE_FILE_NAMES.find(([file]) => file === name);
  if (named) return named[1];
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return null;
  const extension = name.slice(dot + 1).toLowerCase();
  const entry = LANGUAGE_EXTENSIONS.find(([, extensions]) =>
    extensions.includes(extension),
  );
  return entry ? entry[0] : null;
}
