import type {
  IntegrationRepairReport as SharedRepairReport,
  IntegrationState,
} from "@armadra/shared";

/**
 * 设置页「集成」一行读的类型，全部来自 `@armadra/shared`（设计
 * agent-integration.md §5）。这里只留别名：页面在 Runtime 那批改动合入前用的
 * 是一份本地声明，字段已逐一对上，别名让页面不必改名。
 */
export type AgentIntegration = IntegrationState;
export type IntegrationMode = IntegrationState["mode"];
export type IntegrationRepairReport = SharedRepairReport;
