import type { MessageModule } from "./index";

/**
 * 账号绑定（S02）与协同能力（H04）的预留状态文案。
 *
 * 这两块都还没有实现，界面只报告状态：`unsupported` 是一个有效状态，
 * 不能显示成 0、空列表或「已连接」（画布设计 §8）。
 */
export const account: MessageModule = {
  "zh-CN": {
    "account.badge.reserved": "节点声明的账号：{account}；账号绑定尚未启用。",
    "host.capabilities": "预留能力",
    "host.capability.presence": "协同在场与编辑租约",
    "host.capability.accountBinding": "节点账号绑定",
    "host.capability.unsupported": "不支持",
    "host.capability.unknown": "未报告",
    "host.capability.reserved": "契约已预留，此服务尚未实现该能力。",
    "host.capability.note":
      "服务未报告不代表支持；未实现的能力在界面上不提供入口。",
  },
  en: {
    "account.badge.reserved":
      "Account declared on this node: {account}. Account binding is not enabled.",
    "host.capabilities": "Reserved capabilities",
    "host.capability.presence": "Presence and edit leases",
    "host.capability.accountBinding": "Node account binding",
    "host.capability.unsupported": "Unsupported",
    "host.capability.unknown": "Not reported",
    "host.capability.reserved":
      "The contract is reserved; this service does not implement the capability.",
    "host.capability.note":
      "Saying nothing is not support either. Unimplemented capabilities get no entry point in the interface.",
  },
};
