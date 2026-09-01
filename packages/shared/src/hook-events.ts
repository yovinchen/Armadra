import type { BuiltinAgentId } from "./agents.js";

/**
 * Hook event names per provider — single source of truth for the installers
 * (apps/runtime `agent/hooks/<provider>.rs`), the settings UI and the tests.
 * See docs/v3-agent-terminal-plan.md §5.3.
 *
 * Bumping `HOOK_CLIENT_REVISION` marks every installed configuration as stale:
 * the settings page shows "reinstall" and the notification bar warns once.
 */
export const HOOK_CLIENT_REVISION = 1;

/** Claude Code — merged into `~/.claude/settings.json` under `hooks`. */
export const CLAUDE_HOOK_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "Notification",
  "PermissionRequest",
  "Stop",
  "StopFailure",
  "SessionEnd",
  "SubagentStart",
  "SubagentStop",
] as const;

/**
 * Codex — `~/.codex/hooks.json` plus the trusted-hash entry in `config.toml`.
 *
 * There is no `Notification` event in Codex: the installer skipped it as
 * unsupported on every run, so it is not listed here either.
 */
export const CODEX_HOOK_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "Stop",
  "SessionEnd",
  "SubagentStart",
  "SubagentStop",
] as const;

/**
 * Gemini CLI — `~/.gemini/settings.json`. `AfterModel` is deliberately not
 * subscribed: it fires per streamed chunk and carries no state we need.
 */
export const GEMINI_HOOK_EVENTS = [
  "SessionStart",
  "BeforeAgent",
  "AfterAgent",
  "BeforeTool",
  "AfterTool",
  "Notification",
  "SessionEnd",
] as const;

/** opencode — plugin on the `event` bus, so the names are bus topics. */
export const OPENCODE_HOOK_EVENTS = [
  "session.idle",
  "message.updated",
  "permission.asked",
  "tool.execute.before",
  "tool.execute.after",
] as const;

export const HOOK_EVENTS: Readonly<
  Record<BuiltinAgentId, readonly string[]>
> = {
  claude: CLAUDE_HOOK_EVENTS,
  codex: CODEX_HOOK_EVENTS,
  gemini: GEMINI_HOOK_EVENTS,
  opencode: OPENCODE_HOOK_EVENTS,
};

export type ClaudeHookEvent = (typeof CLAUDE_HOOK_EVENTS)[number];
export type CodexHookEvent = (typeof CODEX_HOOK_EVENTS)[number];
export type GeminiHookEvent = (typeof GEMINI_HOOK_EVENTS)[number];
export type OpencodeHookEvent = (typeof OPENCODE_HOOK_EVENTS)[number];

export function hookEventsFor(agentId: BuiltinAgentId): readonly string[] {
  return HOOK_EVENTS[agentId];
}
