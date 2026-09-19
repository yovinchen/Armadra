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
  },
  en: {
    "account.badge.reserved":
      "Account declared on this node: {account}. Account binding is not enabled.",
  },
};
