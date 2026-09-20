/**
 * Hook event names per provider — mirroring
 * `packages/shared/src/hook-events.ts` exactly.
 *
 * The tables are repeated here rather than imported for the same reason
 * the pre-merge implementation repeats them: the installers must
 * keep working in a build of the core that does not carry the front end's
 * package. A test asserts the two agree.
 */

/**
 * Bumping this marks every installed configuration as stale.
 *
 * This is the **event contract** between the client and the core, not the
 * integration's version: the design keeps it fixed while the way the adapter
 * is injected changes (docs/design/agent-integration.md §2).
 */
export const HOOK_CLIENT_REVISION = 4;

/** The revision of the skill half, mirroring `collab::skills::SKILLS_REVISION`. */
export const SKILLS_REVISION = 8;

/**
 * One number for "is this CLI integrated, and is it current" — the hook
 * revision and the skill revision folded together
 * (docs/design/agent-integration.md §2).
 *
 * Hook and skill are one install unit, so they have one staleness question.
 * The composition is positional rather than a sum so that a report can be read
 * back: `<hook>×100 + <skill>` names both halves, and either one moving moves
 * the whole. It is not a wire constant — nobody parses it apart — but a number
 * a person reading a bug report can decompose is worth the arithmetic.
 */
export const INTEGRATION_REVISION =
  HOOK_CLIENT_REVISION * 100 + SKILLS_REVISION;

/** The substring that identifies a command as ours. */
export const CLIENT_NAME = "armadra-hook";

/** Claude Code — the hooks block of the settings file `--settings` points at. */
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
 * Codex — `<CODEX_HOME>/hooks.json` plus the trusted-hash entry in
 * `config.toml`. There is no `Notification` event in Codex.
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
 * Pi — handler names the generated TS extension registers, not keys in a
 * settings file (协作通道 §3.3). `agent_settled` is the one the idle gate
 * reads: Pi documents it as the event a status integration should use, and it
 * is the only one that says the CLI is genuinely idle rather than between two
 * of its own steps. `tool_call` is observed, never blocked — §3.5 forbids
 * manufacturing a permission dialog the CLI never asked for.
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
 * Oh My Pi — Pi's list plus its own settle and compaction events. It is a
 * fork, so the names are listed rather than inherited.
 *
 * Verified against `@oh-my-pi/pi-coding-agent` 18.1.8: that build settles
 * through `session_stop`, not `agent_settled`, and has no `model_select`.
 * Both Pi spellings stay registered anyway — `on()` is a map insert, an event
 * the CLI never emits costs nothing, and a fork that re-converges keeps
 * working without a reinstall.
 */
export const OMP_HOOK_EVENTS = [
  "session_start",
  "before_agent_start",
  "agent_start",
  "tool_call",
  "tool_result",
  "agent_end",
  "agent_settled",
  "session_stop",
  "session_compact",
  "model_select",
  "session_shutdown",
  "auto_compaction_end",
] as const;

/**
 * GitHub Copilot CLI — command hooks in `~/.copilot/hooks/armadra.json`.
 *
 * `preToolUse` is absent and must stay absent: it is Copilot's only blocking
 * event and reads a non-zero exit or a crash as a denial (§6). Subscribing it
 * would turn a missing binary or a moved path into "every tool call is
 * refused", on a channel whose whole contract is that it fails open.
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

/**
 * Handlers that also push a `ctx.getContextUsage()` reading. Pi's own
 * documentation calls `agent_settled` the event a status integration should
 * use, and the compaction/model events are the two moments an existing reading
 * stops describing the session.
 */
export const PI_CONTEXT_EVENTS = [
  "agent_end",
  "agent_settled",
  "session_compact",
  "model_select",
] as const;

/**
 * Oh My Pi 18.x settles through `session_stop` rather than `agent_settled` and
 * compacts through `auto_compaction_end`; both are added to Pi's list.
 */
export const OMP_CONTEXT_EVENTS = [
  "agent_end",
  "agent_settled",
  "session_stop",
  "session_compact",
  "auto_compaction_end",
  "model_select",
] as const;

/** opencode exposes no live context window, so no handler pushes a reading. */
export const OPENCODE_CONTEXT_EVENTS: readonly string[] = [];
