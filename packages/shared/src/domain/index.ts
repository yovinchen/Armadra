/**
 * Domain model v3 — see docs/v3-agent-terminal-plan.md §3.4, §5 and §6.
 *
 * Nine node types, a single
 * persisted edge kind, no per-node `status` (agent
 * state lives in the `agent_status` table and is pushed over the workspace
 * event socket) and no `zoom` tri-state (collapse / resize / maximize replace
 * it). The enumerations are exported as plain arrays so the UI can iterate
 * them without re-deriving the list from the zod schema.
 */

export * from "./primitives.js";
export * from "./node-data.js";
export * from "./nodes.js";
export * from "./boards.js";
export * from "./workspaces.js";
export * from "./agent-status.js";
