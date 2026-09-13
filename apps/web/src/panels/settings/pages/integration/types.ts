import { z } from "zod";

/**
 * 接入状态的契约（[Agent 接入归一](../../../../../../../docs/design/agent-integration-mcp.md) §6）。
 *
 * **这是一份本地声明。** Runtime 侧的 `GET /api/agents/{id}/integration` 与
 * `POST …/integration/repair` 由另一批改动加，`@armadra/shared` 里的类型也归
 * 它们；合入时把这个文件删掉，改成从 shared 引入同名类型即可——字段与这里
 * 逐一对应，页面不需要改。
 *
 * 形状按 2026-09-13 的方向调整：**不走 MCP**，仍然是 Hook 上报事件 + 技能
 * 教会 CLI 画布动词，两者合成一个安装单元（一个「安装 / 卸载」按钮同时管
 * 它们），所以这里是 `hook` + `skill`，不是 `mcp`。
 */

/**
 * 这个 CLI 的接入是**怎么送进去**的（设计 §4）。
 *
 *  - `launch`：启动那一次用命令行参数带进去（Claude 的 `--settings`、
 *    Copilot 的 `--additional-mcp-config`…），用户的全局配置一个字节不动；
 *  - `file`：只能写配置文件（Codex 的 `hooks.json`、Gemini 的 `settings.json`），
 *    所以写法必须幂等、带标记、可修复；
 *  - `extension`：CLI 进程内的扩展自己连 `hook.sock`，没有外部进程也没有配置
 *    条目（Pi / Oh My Pi / OpenCode）。
 */
export const INTEGRATION_MODES = ["launch", "file", "extension"] as const;
export type IntegrationMode = (typeof INTEGRATION_MODES)[number];

/** Hook 那一半：和现在的 `hookInstallReport` 同形，只是多了「装没装」。 */
export const integrationHookSchema = z.looseObject({
  installed: z.boolean(),
  /** 装着的客户端版本；没装时缺席。 */
  revision: z.number().int().nonnegative().nullish(),
  /** 写到哪个文件；`extension` 模式下是那份扩展的路径。 */
  path: z.string().nullish(),
  /** 装成了但有话要说（例如保留了用户自己的 statusLine）。 */
  warning: z.string().nullish(),
});

/** 技能那一半：磁盘上那份 `SKILL.md`，没有别的记录。 */
export const integrationSkillSchema = z.looseObject({
  installed: z.boolean(),
  revision: z.number().int().nonnegative().nullish(),
  path: z.string().nullish(),
});

/**
 * 旧产品名时期留下的东西（设计 §5）。
 *
 * 每条是磁盘上的**一处**：配置文件里的一个 hook 条目，或者一个技能目录。
 * 字符串就够——页面要做的只是把它们列出来，让用户在按「修复」之前看得见
 * 将要动哪些东西。
 */
export const integrationLegacySchema = z.looseObject({
  found: z.array(z.string()).default([]),
});

export const agentIntegrationSchema = z.looseObject({
  agentId: z.string(),
  mode: z.enum(INTEGRATION_MODES),
  hook: integrationHookSchema,
  skill: integrationSkillSchema,
  legacy: integrationLegacySchema,
  /** 当前这一版接入物的版本号；装好之后应当与 `hook.revision` 一致。 */
  revision: z.number().int().nonnegative(),
});

/**
 * `POST /api/agents/{id}/integration/repair` 的结果（设计 §5）。
 *
 * `kept` 是「认出来了但不动」：只清我们自己写过的条目，用户手写的东西原样
 * 留下。`backup` 是动手之前那份原文件的副本；一个字节都没改时缺席。
 */
export const integrationRepairSchema = z.looseObject({
  agentId: z.string(),
  found: z.array(z.string()).default([]),
  removed: z.array(z.string()).default([]),
  kept: z.array(z.string()).default([]),
  backup: z.string().nullish(),
});

export type AgentIntegration = z.infer<typeof agentIntegrationSchema>;
export type IntegrationRepairReport = z.infer<typeof integrationRepairSchema>;
