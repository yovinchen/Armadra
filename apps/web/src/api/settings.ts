import { z } from "zod";
import {
  TERMINAL_BACKEND_CHOICES,
  answerSshPromptRequestSchema,
  customAgentSchema,
  executionHostRefusalSchema,
  powerPolicySchema,
  remoteWorkerProbeSchema,
  sshHostKeyScanSchema,
  sshHostSchema,
  sshPromptListSchema,
  sshTestResultSchema,
  switchExecutionHostRequestSchema,
  trustSshHostKeyRequestSchema,
  workspaceSchema,
  type CustomAgent,
  type ExecutionHostRefusal,
  type PowerPolicy,
  type SshHost,
  type SwitchExecutionHostRequest,
} from "@armadra/shared";
import {
  RuntimeRequestError,
  json,
  noContentSchema,
  query,
  request,
} from "./request";

/* ------------------------------------ 设置 -------------------------------- */

/**
 * `GET/PATCH /api/settings`。
 *
 * Runtime 侧把 settings.json 当作「已知键归一 + 未知键透传」的裸对象
 * （apps/runtime/src/settings.rs），所以这里也用宽松 object：
 * 只校验我们要读的 `terminal` 段，其它键原样留着，免得新旧版本互删配置。
 */
export const runtimeSettingsSchema = z.looseObject({
  terminal: z
    .object({
      backend: z.enum(TERMINAL_BACKEND_CHOICES).default("auto"),
      detachedGraceMinutes: z.number().int().positive().default(1440),
      /**
       * `terminal.dormantAfterSeconds`（T03，宿主设计 §7.2）。会话没有任何
       * 客户端附着这么久之后，Runtime 放慢它的输出投递——进程照跑，回放缓冲
       * 照留，一个字节都不丢。`0` = 关闭。
       */
      dormantAfterSeconds: z.number().int().nonnegative().default(120),
    })
    .default({
      backend: "auto",
      detachedGraceMinutes: 1440,
      dormantAfterSeconds: 120,
    }),
  /** 每个工作空间一段（`workspaces.<id>`）。 */
  workspaces: z
    .record(
      z.string(),
      z.looseObject({
        /** 这块工作空间里新建 Agent 节点时的默认 CLI（§24.1 工作区页）。 */
        defaultAgent: z.string().optional(),
      }),
    )
    .optional(),
  /**
   * 自定义 Agent（§24.1 Agent 页）。`catch([])` 是刻意的：手改坏一条不该让
   * 整份设置解析失败，坏条目丢掉即可——和 `ssh.hosts` 同样的处理。
   */
  agents: z
    .looseObject({ custom: z.array(customAgentSchema).catch([]).default([]) })
    .optional(),
  /** Hook 直答（§5.5）：权限请求直接由 Runtime 回，不弹节点头部按钮。 */
  hooks: z.looseObject({ replyApprovals: z.boolean().optional() }).optional(),
  /**
   * `usage.*`（§19 + §4.2）。`enabled` 关掉后 Runtime 不再向任何 provider
   * 取用量；`providers` 是逐个开关，`refreshMinutes` 的 `0` 表示只手动刷新，
   * `cost.enabled` 控制本地转录扫描。
   */
  usage: z
    .looseObject({
      enabled: z.boolean().optional(),
      refreshMinutes: z.number().int().nonnegative().optional(),
      providers: z.record(z.string(), z.boolean()).optional(),
      codexCliFallback: z.boolean().optional(),
      cost: z.looseObject({ enabled: z.boolean().optional() }).optional(),
    })
    .optional(),
  /**
   * `language.*`（语言服务设计 §1.2、§3.3）。
   *
   * `servers.<serverId>` 是用户自己的覆盖：可执行路径、参数、开关，以及
   * 原样交给 server 的 `initializationOptions` / `settings`。这里刻意没有
   * 「安装」这类键——Armadra 不下载、不安装任何 language server。
   */
  language: z
    .looseObject({
      idleStopSeconds: z.number().int().nonnegative().optional(),
      maxServers: z.number().int().positive().optional(),
      maxRssBytes: z.number().int().nonnegative().optional(),
      formatOnSave: z.boolean().optional(),
      servers: z
        .record(
          z.string(),
          z.looseObject({
            path: z.string().optional(),
            args: z.array(z.string()).optional(),
            enabled: z.boolean().optional(),
          }),
        )
        .optional(),
    })
    .optional(),
  /** `.armadra` 日志保留天数；`0` = 永久（§24.1 数据页）。 */
  logs: z
    .looseObject({ retentionDays: z.number().int().nonnegative().optional() })
    .optional(),
  /**
   * 更新偏好（S03 §4.1）。通道以前只是 React 局部状态，刷新就忘、桌面壳与
   * 浏览器各说各话；现在落在这份文档里。`development` 不是可选项——它描述的
   * 是「没过 CI 的构建」，不是一个能选的通道，Runtime 侧会把未知值归回
   * `stable`。
   */
  updates: z
    .looseObject({
      channel: z.enum(["stable", "beta"]).catch("stable").optional(),
      autoCheck: z.boolean().optional(),
      autoDownload: z.boolean().optional(),
      notify: z.boolean().optional(),
    })
    .optional(),
  /** 防休眠策略（T02，终端宿主设计 §9）；哪些来源的租约可以生效。 */
  power: z.looseObject({ policy: powerPolicySchema.optional() }).optional(),
  /** 资源面板打开时的采样间隔；Runtime 侧会夹在 500ms–60s 之间。 */
  resources: z
    .looseObject({ intervalMs: z.number().int().positive().optional() })
    .optional(),
  /**
   * 用户改过的键位（§24.1 快捷键页；终端宿主设计 §10）。
   *
   * 按平台分开存：`{ mac: { "canvas.tidy": "Mod+Shift+K" }, other: { … } }`。
   * 旧版本写的扁平 `{ "canvas.tidy": "Mod+Shift+K" }`（两个平台共用一条）
   * 仍然读得进来，前端首次加载时迁移一次；所以这里两种形状都收，
   * 由 `panels/settings/keymap.ts` 归一。
   */
  keymap: z
    .record(z.string(), z.union([z.string(), z.record(z.string(), z.string())]))
    .optional(),
  /**
   * SSH 主机表（§21）。Runtime 在 `normalize` 里丢掉校验不过的条目，
   * 所以这里读到的一定是可以直接建终端的主机；`catch` 兜住旧 Runtime
   * （还没有这一段）与手改坏的文件，不让整份设置解析失败。
   */
  ssh: z
    .looseObject({ hosts: z.array(sshHostSchema).catch([]).default([]) })
    .optional(),
});

export type RuntimeSettings = z.infer<typeof runtimeSettingsSchema>;

/** PATCH 是按段浅合并，因此每段都可以只给一部分键。 */
export interface RuntimeSettingsPatch {
  terminal?: Partial<RuntimeSettings["terminal"]>;
  workspaces?: Record<string, { defaultAgent?: string | null }>;
  /** 数组是整段替换（Runtime 的 merge 只对对象递归），删主机就是发新数组。 */
  ssh?: { hosts: SshHost[] };
  agents?: { custom: CustomAgent[] };
  hooks?: { replyApprovals?: boolean };
  usage?: {
    enabled?: boolean;
    refreshMinutes?: number;
    providers?: Record<string, boolean>;
    codexCliFallback?: boolean;
    cost?: { enabled?: boolean };
  };
  logs?: { retentionDays?: number };
  /** 更新通道与两个开关（S03 §4.1）。 */
  updates?: {
    channel?: "stable" | "beta";
    autoCheck?: boolean;
    autoDownload?: boolean;
    notify?: boolean;
  };
  /**
   * 语言服务。`servers` 是按 serverId 的浅合并，所以关掉一个 server 只要
   * 发它自己那一段；`null` 让 Runtime 的 merge 删掉这个键。
   */
  language?: {
    idleStopSeconds?: number;
    maxServers?: number;
    maxRssBytes?: number;
    formatOnSave?: boolean;
    servers?: Record<
      string,
      { path?: string | null; args?: string[]; enabled?: boolean }
    >;
  };
  /** 防休眠策略（T02）。 */
  power?: { policy?: PowerPolicy };
  /** 资源面板采样间隔；Runtime 侧会夹回 500ms–60s。 */
  resources?: { intervalMs?: number };
  /**
   * 分平台的键位覆盖：`{ mac: { "canvas.tidy": "Mod+Shift+K" } }`。
   * `null` 删掉一条（回到上一层），迁移时也用它删掉旧的扁平键。
   */
  keymap?: Record<
    string,
    string | null | Record<string, string | null> | undefined
  >;
}

export const settingsApi = {
  /* ----------------------------------- 设置 ----------------------------- */
  settings: () => request("/api/settings", runtimeSettingsSchema),
  /**
   * 连通性探测（§21）：Runtime 跑一次
   * `ssh -o BatchMode=yes -o ConnectTimeout=5 <目标> true`，
   * 回 `{ok, output}`；`output` 只有末几行且已脱敏。
   */
  testSshHost: (hostId: string) =>
    request(`/api/ssh/hosts/${query(hostId)}/test`, sshTestResultSchema, {
      method: "POST",
    }),
  /** Whether the remote Armadra Worker is installed and matches this build. */
  testRemoteWorker: (hostId: string) =>
    request(
      `/api/ssh/hosts/${query(hostId)}/worker/test`,
      remoteWorkerProbeSchema,
      { method: "POST" },
    ),
  updateSettings: (patch: RuntimeSettingsPatch) =>
    request("/api/settings", runtimeSettingsSchema, {
      method: "PATCH",
      ...json(patch),
    }),

  /* --------------------------------- 主机密钥 --------------------------- */

  /**
   * 扫描主机公布的密钥（远端补完设计 §3.6）。
   *
   * 只读：不写文件，也不代替任何人做判断。回答里的 `known` 是当前已记录的
   * 指纹，界面把新旧摆在一起，由人来比对服务器自己打印的那一串。
   */
  scanSshHostKeys: (hostId: string) =>
    request(
      `/api/ssh/hosts/${query(hostId)}/host-keys/scan`,
      sshHostKeyScanSchema,
      { method: "POST" },
    ),
  /**
   * 记录一条扫描到的密钥。`line` 原样回传，写进 `known_hosts` 的就是刚才
   * 显示指纹的那几个字节；`replace` 只有替换已记录的密钥时才带。
   */
  trustSshHostKey: (hostId: string, line: string, replace = false) =>
    request(`/api/ssh/hosts/${query(hostId)}/host-keys`, sshHostKeyScanSchema, {
      method: "POST",
      ...json(
        trustSshHostKeyRequestSchema.parse(
          replace ? { line, replace: true } : { line },
        ),
      ),
    }),
  /** 清掉 Armadra 为这台主机记下的信任；用户自己的 known_hosts 不动。 */
  forgetSshHostKeys: (hostId: string) =>
    request(`/api/ssh/hosts/${query(hostId)}/host-keys`, noContentSchema, {
      method: "DELETE",
    }),

  /* ---------------------------------- 认证提示 -------------------------- */

  /** 刚连上的客户端补齐当前还等着人回答的提示。 */
  sshPrompts: () => request("/api/ssh/prompts", sshPromptListSchema),
  /**
   * 回答一条提示。答案只在 Runtime 内存里停留到 askpass 取走那一次，
   * 不落盘也不进日志——所以这里也不缓存、不重试。
   */
  answerSshPrompt: (hostId: string, promptId: string, answer: string) =>
    request(
      `/api/ssh/hosts/${query(hostId)}/prompts/${query(promptId)}`,
      noContentSchema,
      {
        method: "POST",
        ...json(answerSshPromptRequestSchema.parse({ answer })),
      },
    ),
  /** 取消：`ssh` 那边干净地失败，好过挂着等一个不会来的答案。 */
  cancelSshPrompt: (hostId: string, promptId: string) =>
    request(
      `/api/ssh/hosts/${query(hostId)}/prompts/${query(promptId)}`,
      noContentSchema,
      { method: "DELETE" },
    ),

  /* --------------------------------- 执行主机 --------------------------- */

  /**
   * 把工作空间改绑到另一台执行主机（设计 §3.3）。
   *
   * 这是重新绑定，不是搬文件：新根必须看起来是同一个项目，旧主机上也不能
   * 还挂着东西。被拒绝时是 409，body 里是结构化的理由——用
   * `executionHostRefusal()` 读出来，光一个「冲突」没人能据此行动。
   */
  switchExecutionHost: (
    workspaceId: string,
    input: SwitchExecutionHostRequest,
  ) =>
    request(
      `/api/workspaces/${query(workspaceId)}/execution-host`,
      workspaceSchema,
      {
        method: "PATCH",
        ...json(switchExecutionHostRequestSchema.parse(input)),
      },
    ),
};

/**
 * 从一次失败的改绑里读出结构化拒绝；不是拒绝就返回 `null`。
 *
 * 分开一个函数是为了不让调用方把「连不上 / 权限不够」当成 Runtime 做出的
 * 判断——只有 409 且 body 认得出来，才是「它看过了，然后不同意」。
 */
export function executionHostRefusal(
  error: unknown,
): ExecutionHostRefusal | null {
  if (!(error instanceof RuntimeRequestError) || error.status !== 409)
    return null;
  const parsed = executionHostRefusalSchema.safeParse(error.body);
  return parsed.success ? parsed.data : null;
}
