import { createHash } from "node:crypto";
import {
  AutomationOutcome,
  AutomationPlanState,
  AutomationRunSchema,
  AutomationRunState,
  type AutomationActivation,
  type AutomationPlan,
  type AutomationReceipt,
  type AutomationRun,
  create,
} from "./types";
import {
  activationToJson,
  canonicalJson,
  receiptToJson,
  runToJson,
} from "./json";

/**
 * 摘要与判定，全是纯函数。
 *
 * 从 `engine.ts` 里分出来不是为了整洁，是因为它们**必须能被单独读懂**：三个摘要
 * 各自冻结了一件不同的事，而「哪些字段参与、哪些不参与」是它们唯一的内容。算错
 * 一个字段，结果不是一次报错，而是一个永远激活不了的计划，或者一张永远对不上号
 * 的收据。
 */

/** 连续多少次不可修复的目标拒绝会把计划标成「需要处理」。 */
export const ATTENTION_THRESHOLD = 2;

const MAX_UINT32 = 4_294_967_295;

export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return false;
  }
  return true;
}

/**
 * 三个摘要都按**规范 JSON 的 UTF-8 字节**算。
 *
 * R7 之前它们是 protobuf 序列化的 SHA-256。换掉的理由和配置摘要那次一样
 * （`docs/contracts/core-json-api.md` §4.2）：一个只有 protobuf 序列化器才算得
 * 出来的数不能是「这条记录」的身份。规范 JSON 由 `json.ts` 的 `canonicalJson`
 * 定义——键排序、无空白，所以同一份记录只有一种文本。
 */
function digest(text: string): Uint8Array {
  return createHash("sha256").update(text, "utf8").digest();
}

/** 激活摘要：授权时刻与摘要本身不参与，这样同一次批准算出同一个数。 */
export function activationDigest(activation: AutomationActivation): Uint8Array {
  const hashed: AutomationActivation = {
    ...activation,
    authorizedAtUnixMs: 0n,
    activationSha256: new Uint8Array(0),
  };
  return digest(canonicalJson(activationToJson(hashed)));
}

/** 收据摘要：一张收据的身份，用来确认拿回来的是同一张。 */
export function receiptDigest(receipt: AutomationReceipt): Uint8Array {
  return digest(canonicalJson(receiptToJson(receipt)));
}

/**
 * 投递摘要：冻结的是「这次投递到底要做什么」。
 *
 * 状态、租约、尝试次数都不在里面——它们会变，而一次投递的身份不能跟着变，否则
 * 重试时收据就对不上号了。
 */
export function dispatchHash(run: AutomationRun): Uint8Array {
  const frozen = create(AutomationRunSchema, {
    id: run.id,
    planId: run.planId,
    workspaceId: run.workspaceId,
    configVersion: run.configVersion,
    scheduledSlot: run.scheduledSlot,
    scheduledAtUnixMs: run.scheduledAtUnixMs,
    ...(run.frozenConfig === undefined
      ? {}
      : { frozenConfig: run.frozenConfig }),
    ...(run.activation === undefined ? {} : { activation: run.activation }),
    operationId: run.operationId,
    misfire: run.misfire,
    missedSlots: run.missedSlots,
    missedSlotsTruncated: run.missedSlotsTruncated,
  });
  return digest(canonicalJson(runToJson(frozen)));
}

export function outcomeState(
  outcome: AutomationOutcome,
): AutomationRunState | undefined {
  switch (outcome) {
    case AutomationOutcome.DELIVERED:
      return AutomationRunState.DELIVERED;
    case AutomationOutcome.RUNNING:
      return AutomationRunState.RUNNING;
    case AutomationOutcome.SUCCEEDED:
      return AutomationRunState.SUCCEEDED;
    case AutomationOutcome.FAILED:
      return AutomationRunState.FAILED;
    case AutomationOutcome.CANCELLED:
      return AutomationRunState.CANCELLED;
    case AutomationOutcome.UNKNOWN:
      return AutomationRunState.UNKNOWN;
    default:
      return undefined;
  }
}

/**
 * 只有不可修复的拒绝才累计。
 *
 * 一次拒绝可能只是终端正在重启；第二次就意味着得有人去修目标或者改计划。反过来
 * 只有「确实观察到送达」才清零——取消、暂停、过期都不能证明目标好了。
 */
export function noteAttention(
  plan: AutomationPlan,
  run: AutomationRun,
  state: AutomationRunState,
  reason: string,
): void {
  if (run.deliveryObserved) {
    plan.needsAttention = false;
    plan.attentionReasonCode = "";
    plan.attentionStreak = 0;
    return;
  }
  const unrepairable =
    state === AutomationRunState.SKIPPED &&
    (reason === "TARGET_UNSUPPORTED" || reason === "STALE_GENERATION");
  if (!unrepairable) return;
  if (plan.attentionStreak < MAX_UINT32) plan.attentionStreak += 1;
  if (plan.attentionStreak >= ATTENTION_THRESHOLD) {
    plan.needsAttention = true;
    plan.attentionReasonCode = reason;
  }
}
