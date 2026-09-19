import type { BuiltinAgentId } from "./agents.js";

/**
 * Hook event names per provider — single source of truth for the installers
 * (apps/runtime `agent/hooks/<provider>.rs`), the settings UI and the tests.
 * See docs/contracts/v3-agent-terminal-plan.md §5.3.
 *
 * Bumping `HOOK_CLIENT_REVISION` marks every installed configuration as stale:
 * the settings page shows "reinstall" and the notification bar warns once.
 *
 * 4 — Pi, Oh My Pi and GitHub Copilot gained a status source, and every event
 * report now carries which channel it arrived on. The four adapters that were
 * already installed are asked to reinstall rather than silently kept: their
 * recorded `client_revision` is what tells the settings page whether the
 * configuration on disk is the one this build writes.
 */
export const HOOK_CLIENT_REVISION = 4;

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

/** opencode — plugin on the `event` bus, so the names are bus topics. */
export const OPENCODE_HOOK_EVENTS = [
  "session.idle",
  "message.updated",
  "permission.asked",
  "tool.execute.before",
  "tool.execute.after",
] as const;

/**
 * Pi — handlers registered by the generated TS extension under
 * `~/.pi/agent/extensions/`, not entries in a settings file
 * (docs/design/agent-collaboration-channels.md §3.3).
 *
 * `agent_settled` is the one that earns the list: Pi documents it as the event
 * a status integration should use, and it is the only one that is evidence the
 * CLI is genuinely idle rather than between two of its own steps. `tool_call`
 * is subscribed to observe, never to block — Armadra does not manufacture a
 * permission dialog a CLI never asked for (§3.5).
 */
export const PI_HOOK_EVENTS = [
  "session_start",
  "before_agent_start",
  "agent_start",
  "tool_call",
  "tool_result",
  "agent_end",
  "agent_settled",
  "session_compact",
  "model_select",
  "session_shutdown",
] as const;

/**
 * Oh My Pi — Pi's extension API plus its own settle and compaction events. OMP
 * is a fork, so the names are verified separately rather than assumed to track
 * Pi.
 *
 * Verified against `@oh-my-pi/pi-coding-agent` 18.1.8: that build settles
 * through `session_stop`, not `agent_settled`, and has no `model_select`. Both
 * Pi spellings stay registered anyway — `pi.on()` is a map insert, an event the
 * CLI never emits costs nothing, and a fork that re-converges keeps working
 * without a reinstall.
 */
export const OMP_HOOK_EVENTS = [
  ...PI_HOOK_EVENTS,
  "session_stop",
  "auto_compaction_end",
] as const;

/**
 * GitHub Copilot CLI — `~/.copilot/hooks/armadra.json`, command hooks like
 * Claude's.
 *
 * `preToolUse` is deliberately absent and must stay absent: it is Copilot's
 * only blocking event, and a non-zero exit or a crash there is read as a denial
 * (§6). Subscribing it would turn a missing binary or a moved path into "every
 * tool call is refused" — a fail-closed edge on a channel whose whole contract
 * is that it fails open.
 */
export const COPILOT_HOOK_EVENTS = [
  "sessionStart",
  "userPromptSubmitted",
  "postToolUse",
  "postToolUseFailure",
  "notification",
  "agentStop",
  "subagentStart",
  "subagentStop",
  "errorOccurred",
  "preCompact",
  "sessionEnd",
] as const;

export const HOOK_EVENTS: Readonly<Record<BuiltinAgentId, readonly string[]>> =
  {
    claude: CLAUDE_HOOK_EVENTS,
    codex: CODEX_HOOK_EVENTS,
    opencode: OPENCODE_HOOK_EVENTS,
    pi: PI_HOOK_EVENTS,
    omp: OMP_HOOK_EVENTS,
    copilot: COPILOT_HOOK_EVENTS,
  };

export type ClaudeHookEvent = (typeof CLAUDE_HOOK_EVENTS)[number];
export type CodexHookEvent = (typeof CODEX_HOOK_EVENTS)[number];
export type OpencodeHookEvent = (typeof OPENCODE_HOOK_EVENTS)[number];
export type PiHookEvent = (typeof PI_HOOK_EVENTS)[number];
export type OmpHookEvent = (typeof OMP_HOOK_EVENTS)[number];
export type CopilotHookEvent = (typeof COPILOT_HOOK_EVENTS)[number];

export function hookEventsFor(agentId: BuiltinAgentId): readonly string[] {
  return HOOK_EVENTS[agentId];
}
