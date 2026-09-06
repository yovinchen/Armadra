/**
 * 文件类型图标：一个文件名 → 一个 lucide 图标。
 *
 * 只用已有依赖里的 lucide 图标，不引图标字体、不引外链——打包壳的 CSP 是
 * `default-src 'self'`，任何外部图标资源都会被静默挡掉，而且整个应用的图标
 * 本来就是内联 SVG。
 *
 * 认不出来的类型给一个通用文件图标，**不是问号**：问号在这个应用里是 Git
 * 的「未跟踪」状态字母（porcelain 的 `??`），把它放在图标位上，读起来就是
 * 「图标没加载出来」。
 *
 * 配色故意是单色的：这一列图标只用来区分「这是什么」，颜色留给旁边的 Git
 * 状态字母。
 */
import {
  Database,
  File,
  FileArchive,
  FileAudio,
  FileCode,
  FileCog,
  FileImage,
  FileJson,
  FileKey,
  FileLock,
  FileSpreadsheet,
  FileTerminal,
  FileText,
  FileType,
  FileVideo,
  Folder,
  type LucideIcon,
} from "lucide-react";

/** 目录和文件走两条不同的分支，调用方只有这两种。 */
export type FileEntryKind = "file" | "directory";

/** 认不出来时的兜底。整个应用只有这一个通用文件图标。 */
export const GENERIC_FILE_ICON: LucideIcon = File;
export const DIRECTORY_ICON: LucideIcon = Folder;

/**
 * 扩展名 → 图标。同一族的语言共用一个图标：这一列的作用是一眼分出代码、
 * 配置、文档和二进制，不是给每种语言一个品牌标志。
 */
const BY_EXTENSION: Readonly<Record<string, LucideIcon>> = {
  // 代码
  ts: FileCode,
  tsx: FileCode,
  mts: FileCode,
  cts: FileCode,
  js: FileCode,
  jsx: FileCode,
  mjs: FileCode,
  cjs: FileCode,
  rs: FileCode,
  go: FileCode,
  py: FileCode,
  rb: FileCode,
  java: FileCode,
  kt: FileCode,
  kts: FileCode,
  swift: FileCode,
  c: FileCode,
  h: FileCode,
  cc: FileCode,
  cpp: FileCode,
  hpp: FileCode,
  cs: FileCode,
  php: FileCode,
  lua: FileCode,
  dart: FileCode,
  scala: FileCode,
  ex: FileCode,
  exs: FileCode,
  proto: FileCode,
  vue: FileCode,
  svelte: FileCode,
  sql: FileCode,
  html: FileCode,
  htm: FileCode,
  xml: FileCode,
  css: FileCode,
  scss: FileCode,
  sass: FileCode,
  less: FileCode,

  // 数据与配置
  json: FileJson,
  jsonc: FileJson,
  json5: FileJson,
  toml: FileCog,
  yaml: FileCog,
  yml: FileCog,
  ini: FileCog,
  cfg: FileCog,
  conf: FileCog,
  env: FileCog,
  properties: FileCog,
  plist: FileCog,
  gradle: FileCog,
  lock: FileLock,

  // 文档
  md: FileText,
  mdx: FileText,
  markdown: FileText,
  txt: FileText,
  rst: FileText,
  adoc: FileText,
  log: FileText,
  pdf: FileText,
  rtf: FileText,
  doc: FileText,
  docx: FileText,

  // 表格
  csv: FileSpreadsheet,
  tsv: FileSpreadsheet,
  xls: FileSpreadsheet,
  xlsx: FileSpreadsheet,

  // 脚本
  sh: FileTerminal,
  bash: FileTerminal,
  zsh: FileTerminal,
  fish: FileTerminal,
  ps1: FileTerminal,
  bat: FileTerminal,
  cmd: FileTerminal,

  // 图像
  png: FileImage,
  jpg: FileImage,
  jpeg: FileImage,
  gif: FileImage,
  svg: FileImage,
  webp: FileImage,
  avif: FileImage,
  bmp: FileImage,
  ico: FileImage,
  icns: FileImage,

  // 音视频
  mp3: FileAudio,
  wav: FileAudio,
  flac: FileAudio,
  ogg: FileAudio,
  m4a: FileAudio,
  mp4: FileVideo,
  mov: FileVideo,
  mkv: FileVideo,
  webm: FileVideo,
  avi: FileVideo,

  // 压缩包与二进制
  zip: FileArchive,
  tar: FileArchive,
  gz: FileArchive,
  tgz: FileArchive,
  bz2: FileArchive,
  xz: FileArchive,
  zst: FileArchive,
  "7z": FileArchive,
  rar: FileArchive,
  jar: FileArchive,
  db: Database,
  sqlite: Database,
  sqlite3: Database,

  // 字体
  ttf: FileType,
  otf: FileType,
  woff: FileType,
  woff2: FileType,
  eot: FileType,

  // 密钥
  pem: FileKey,
  key: FileKey,
  crt: FileKey,
  cer: FileKey,
  pub: FileKey,
};

/** 没有扩展名、或者扩展名说明不了什么的文件，按整个文件名认。 */
const BY_NAME: Readonly<Record<string, LucideIcon>> = {
  dockerfile: FileCog,
  containerfile: FileCog,
  makefile: FileCog,
  justfile: FileCog,
  rakefile: FileCog,
  procfile: FileCog,
  ".gitignore": FileCog,
  ".gitattributes": FileCog,
  ".gitmodules": FileCog,
  ".dockerignore": FileCog,
  ".npmrc": FileCog,
  ".nvmrc": FileCog,
  ".editorconfig": FileCog,
  ".prettierignore": FileCog,
  ".env": FileCog,
  license: FileText,
  "license.md": FileText,
  notice: FileText,
  readme: FileText,
  changelog: FileText,
  "cargo.lock": FileLock,
  "package-lock.json": FileLock,
  "pnpm-lock.yaml": FileLock,
  "yarn.lock": FileLock,
  "bun.lockb": FileLock,
  "go.sum": FileLock,
};

/** `a/b/c.tsx` → `c.tsx`。路径和裸文件名都能进来。 */
function basename(path: string): string {
  const trimmed = path.replace(/[/\\]+$/, "");
  const cut = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return cut === -1 ? trimmed : trimmed.slice(cut + 1);
}

/**
 * 这个名字该用哪个图标。目录永远是文件夹；其余先按整名匹配（`Dockerfile`、
 * `pnpm-lock.yaml`），再按最后一段扩展名匹配（`a.tar.gz` 认 `gz`），都认不
 * 出来时是通用文件图标。
 */
export function fileIconFor(
  path: string,
  kind: FileEntryKind = "file",
): LucideIcon {
  if (kind === "directory") return DIRECTORY_ICON;
  const name = basename(path).toLowerCase();
  const named = BY_NAME[name];
  if (named) return named;
  // `.gitignore` 这类点开头的名字整体就是名字，不是「扩展名 gitignore」。
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return GENERIC_FILE_ICON;
  return BY_EXTENSION[name.slice(dot + 1)] ?? GENERIC_FILE_ICON;
}

/** 列表行开头那个图标。 */
export function FileTypeIcon({
  path,
  kind = "file",
  className,
}: {
  path: string;
  kind?: FileEntryKind;
  className?: string;
}) {
  const Icon = fileIconFor(path, kind);
  return <Icon aria-hidden className={className} />;
}
