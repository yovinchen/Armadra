import type { MessageModule } from "./index";

/**
 * 「看一眼这个 Agent」的文案（业务迁移 §2.7 的 `ReadTranscript` /
 * `CaptureScreen`）。
 *
 * `unavailable` 是兜底，不是常态：后端拒绝时会带上自己的理由（哪个 CLI、
 * 为什么读不到），界面照原样显示。只有连理由都没拿到时才用这一句。
 */
const zh = {
  "agentInspect.menu": "更多",
  "agentInspect.transcript": "转录",
  "agentInspect.screen": "终端画面",
  "agentInspect.description": "只读一眼，不写入这个会话，也不触发新的一轮。",
  "agentInspect.loading": "读取中…",
  "agentInspect.truncated": "只显示了尾部；更早的内容请直接看转录文件。",
  "agentInspect.unavailable": "这个会话现在读不到。",
} as const;

const en: Record<keyof typeof zh, string> = {
  "agentInspect.menu": "More",
  "agentInspect.transcript": "Transcript",
  "agentInspect.screen": "Terminal screen",
  "agentInspect.description":
    "A read-only look. Nothing is written to the session and no turn is started.",
  "agentInspect.loading": "Reading…",
  "agentInspect.truncated":
    "Only the tail is shown. Read the transcript file for anything earlier.",
  "agentInspect.unavailable": "This session cannot be read right now.",
};

export const agentInspect: MessageModule = { "zh-CN": zh, en };
