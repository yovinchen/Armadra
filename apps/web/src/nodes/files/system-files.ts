/**
 * 各个操作系统自己丢在目录里的元数据文件（用户实测反馈 F4）。
 *
 * 用户的原话是「内容展示问题（`.DS_Store` 等）」：一个 240px 宽的文件管理器
 * 节点里，Finder / 资源管理器的记账文件会把真正的文件挤下去，而它们既不是
 * 用户写的，也没人打算打开它们。
 *
 * 只按**准确的文件名**匹配，不按「点开头」：`.gitignore`、`.env`、
 * `.github/` 全是用户自己的东西，一条「隐藏点文件」的规则会把它们一起藏掉。
 * 大小写不敏感——Windows 与 macOS 的文件系统本来就不区分。
 */
const SYSTEM_FILE_NAMES: ReadonlySet<string> = new Set([
  // macOS：Finder 的目录视图设置。
  ".ds_store",
  // Windows：资源管理器的缩略图缓存与目录视图设置。
  "thumbs.db",
  "desktop.ini",
]);

export function isSystemFile(name: string): boolean {
  return SYSTEM_FILE_NAMES.has(name.toLowerCase());
}
