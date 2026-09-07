import { z } from "zod";
import { gitCommitRecordSchema } from "@armadra/shared";

/**
 * 多仓库日志与分支树的读取形状（Git 工具窗口设计 §3.1）。
 *
 * **临时住在这里**：Runtime 的 `POST …/git/log` 与 `GET …/git/refs` 还在另一
 * 条线上做，两条接口落地并进了 `@armadra/shared` 之后，这个文件整个删掉、
 * `log-client.ts` 换成 `gitGateway` 的两个方法即可——界面读的是这里导出的
 * 类型，不是请求本身，所以那次替换不会波及三栏中的任何一个组件。
 *
 * 字段名与 §3.1 逐条对齐（camelCase，与 Runtime 的 JSON 约定一致）。
 */

/* --------------------------------- 请求 ----------------------------------- */

/** 分支选择：`head` 只看各仓库的 HEAD，`all` 全部引用，`named` 指定若干。 */
export interface GitLogRefs {
  kind: "head" | "all" | "named";
  names: string[];
}

export interface GitLogTextFilter {
  query: string;
  regex: boolean;
  matchCase: boolean;
}

export interface GitLogRequest {
  /** 省略或空数组 = 全部已发现仓库。 */
  repositories: string[];
  refs: GitLogRefs;
  authors: string[];
  /** ISO 日期串；空串 = 不限。 */
  since: string | null;
  until: string | null;
  paths: string[];
  text: GitLogTextFilter | null;
  /** 上一页的 `nextCursor`；筛选条件变了它就作废（服务端按条件哈希绑定）。 */
  cursor: string | null;
  limit: number;
}

/* --------------------------------- 响应 ----------------------------------- */

/** `CommitRecord` + 它来自哪个仓库。图的节点身份是这两者的组合。 */
export const logCommitSchema = gitCommitRecordSchema.extend({
  repositoryPath: z.string(),
});

export const logRepositorySchema = z.object({
  path: z.string(),
  /** 调色板序号，不是色值：主题换了颜色也得跟着换。 */
  color: z.number().int().min(0),
});

export const gitLogPageSchema = z.object({
  commits: z.array(logCommitSchema),
  nextCursor: z.string().nullable(),
  repositories: z.array(logRepositorySchema),
  /** 仓库数超过上限时只合并了前 32 个。 */
  truncated: z.boolean().default(false),
});

export type LogCommit = z.infer<typeof logCommitSchema>;
export type LogRepository = z.infer<typeof logRepositorySchema>;
export type GitLogPage = z.infer<typeof gitLogPageSchema>;

/* ------------------------------- 分支树数据 -------------------------------- */

const refBranchSchema = z.object({
  name: z.string(),
  oid: z.string(),
  upstream: z.string().nullable().default(null),
  ahead: z.number().int().nullable().default(null),
  behind: z.number().int().nullable().default(null),
  current: z.boolean().default(false),
});

const refRemoteSchema = z.object({
  name: z.string(),
  branches: z.array(refBranchSchema),
});

const refWorktreeSchema = z.object({
  path: z.string(),
  branch: z.string().nullable().default(null),
  isMain: z.boolean().default(false),
});

export const gitRefsRepositorySchema = z.object({
  repositoryPath: z.string(),
  name: z.string(),
  /** 当前分支名；分离 HEAD 时是 `null`。 */
  head: z.string().nullable().default(null),
  branches: z.array(refBranchSchema),
  remotes: z.array(refRemoteSchema),
  tags: z.array(z.string()),
  worktrees: z.array(refWorktreeSchema),
  stashCount: z.number().int().min(0).default(0),
});

export const gitRefsSchema = z.array(gitRefsRepositorySchema);

export type GitRefsBranch = z.infer<typeof refBranchSchema>;
export type GitRefsRemote = z.infer<typeof refRemoteSchema>;
export type GitRefsWorktree = z.infer<typeof refWorktreeSchema>;
export type GitRefsRepository = z.infer<typeof gitRefsRepositorySchema>;
