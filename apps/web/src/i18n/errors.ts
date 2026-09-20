import type { MessageModule } from "./index";

/**
 * core 的错误码 → 界面上那句话。
 *
 * core 的 `{ code, message }` 里 `message` 是中文（它的注释与日志通篇如此），
 * 页面原样透出去，英文界面上就会冒出一句中文。所以**一律按 `code` 取文案**，
 * `message` 只在这张表认不出这个码时兜底。映射表在 `api/request.ts`。
 *
 * 代价是具体度：`bad_request` 的原话常常说得出是哪个字段，而这里只说「请求
 * 无效」。原话没有丢——`RuntimeRequestError.coreMessage` 还留着它，需要细节的
 * 调用点（执行主机改绑的 409 就是一例）自己读 `body`。一句看不懂的中文对一个
 * 英文用户的价值是零，而这张表至少说得出该怎么办。
 */
export const errors: MessageModule = {
  "zh-CN": {
    "error.notFound": "找不到这个对象",
    "error.forbidden": "没有权限执行这个操作",
    "error.badRequest": "请求无效",
    "error.methodNotAllowed": "这个接口不接受该操作",
    "error.conflict": "对象已被改动，请重新加载后重试",
    "error.payloadTooLarge": "内容太大，超出了单次请求的上限",
    "error.unavailable": "这项服务暂时不可用，请稍后重试",
    "error.notImplemented": "当前版本还没有这个功能",
    "error.internal": "核心处理这个请求时失败",
    "error.unsupported": "这台机器不支持这个操作",
    "error.unsupportedOnRemote":
      "这个操作只能在 Armadra 所在的机器上执行，当前工作区在另一台。",
    "error.unauthenticated": "登录已失效，请重新连接账户",
    "error.permissionDenied": "账户没有这项权限",
    "error.rateLimited": "请求过于频繁，请稍后重试",
    "error.unknownOutcome": "结果未知：请重新加载后确认是否已生效",

    /* 投递的拒绝码（`agent-delivery.md` §3.5）。机器码本身不翻译，这里给的是
       「发生了什么」，因为看着画布的人不该去读 core 的中文句子。 */
    "error.delivery.LOOP_DETECTED": "这两个节点在互相投递，已经停下",
    "error.delivery.RATE_LIMITED": "这条边上的投递太密集，已经退避",
    "error.delivery.TARGET_AWAITING_APPROVAL":
      "目标停在一个权限提示上，没有替它回答",
    "error.delivery.LEASE_HELD_BY_HUMAN": "有人正在这个终端里打字",
    "error.delivery.LEASE_REVOKED": "有人接管了这个终端",
    "error.delivery.LEASE_HELD_BY_AGENT": "另一个 Agent 正在驱动它",
    "error.delivery.TARGET_BUSY": "目标正在一轮里",
    "error.delivery.TARGET_STARTING": "目标刚起来，还没报过状态",
    "error.delivery.QUEUE_FULL": "这个目标的队伍满了",
    "error.delivery.TARGET_GONE": "目标没有在运行的会话",
  },
  en: {
    "error.notFound": "Not found",
    "error.forbidden": "You do not have permission to do this",
    "error.badRequest": "The request was not valid",
    "error.methodNotAllowed": "This endpoint does not accept that operation",
    "error.conflict": "It changed since you loaded it — reload and try again",
    "error.payloadTooLarge": "Too large for a single request",
    "error.unavailable": "Temporarily unavailable — try again shortly",
    "error.notImplemented": "This build does not have that yet",
    "error.internal": "The core failed while handling this request",
    "error.unsupported": "This machine does not support that",
    "error.unsupportedOnRemote":
      "This runs only on the machine Armadra is on; this workspace is on another.",
    "error.unauthenticated": "Your sign-in expired — reconnect the account",
    "error.permissionDenied": "That account lacks this permission",
    "error.rateLimited": "Too many requests — try again shortly",
    "error.unknownOutcome":
      "Outcome unknown — reload to see whether it applied",

    "error.delivery.LOOP_DETECTED":
      "These two nodes are feeding each other — stopped",
    "error.delivery.RATE_LIMITED":
      "Too many deliveries on this link — backing off",
    "error.delivery.TARGET_AWAITING_APPROVAL":
      "The target is on a permission prompt; nobody answered it for them",
    "error.delivery.LEASE_HELD_BY_HUMAN": "Someone is typing in that terminal",
    "error.delivery.LEASE_REVOKED": "Someone took that terminal over",
    "error.delivery.LEASE_HELD_BY_AGENT": "Another agent is driving it",
    "error.delivery.TARGET_BUSY": "The target is in a turn",
    "error.delivery.TARGET_STARTING":
      "The target just started and has not reported yet",
    "error.delivery.QUEUE_FULL": "That target's queue is full",
    "error.delivery.TARGET_GONE": "The target has no running session",
  },
};
