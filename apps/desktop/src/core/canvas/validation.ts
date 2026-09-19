import {
  badRequest,
  isHexColor,
  isRfc3339,
  isUuid,
} from "../workspaces/support";
import type { Viewport } from "./boards";
import type { CanvasEdge, CanvasNode } from "./document-types";

/**
 * What a board document may contain.
 *
 * A port of `apps/runtime/src/db/validation.rs`, and the one module here that
 * has to be read as a specification rather than as code: it is the only thing
 * standing between a client's JSON and the rows every other domain reads. The
 * per-type payload rules in particular are deliberately exhaustive — an
 * unknown `type` is refused, never stored "just in case".
 *
 * The bounds are mirrored in `packages/shared/src/domain`; the two have to
 * agree, and the front end parses with the zod copy before it ever posts.
 */

/** Mirrored as `NODE_TYPES` in packages/shared. */
export const NODE_TYPES = [
  "terminal",
  "sticky",
  "group",
  "editor",
  "diff",
  "files",
  "browser",
  "automation",
  "agentActivity",
] as const;

export const EDGE_KINDS = ["link"] as const;
export const PERMISSION_MODES = [
  "default",
  "auto-edit",
  "full-auto",
  "plan",
] as const;
export const DIFF_SCOPES = ["worktree", "staged"] as const;
export const AUTOMATION_SCHEDULE_KINDS = [
  "once",
  "interval",
  "cron",
  "loop",
] as const;
export const AGENT_ACTIVITY_SOURCES = ["loop", "subagent"] as const;
export const NATIVE_RECURRENCE_DIALECTS = ["cron", "launchd"] as const;
export const BUILTIN_AGENT_IDS = [
  "claude",
  "codex",
  "opencode",
  "pi",
  "omp",
  "copilot",
] as const;

const MAX_STICKY_CONTENT = 20_000;
const MAX_NODE_LABELS = 8;
const MAX_NODE_LABEL_CHARS = 24;
const MAX_NODE_NOTE_CHARS = 4_000;

/**
 * Whiteboard snapshot cap — mirrored as `MAX_WHITEBOARD_BYTES` in
 * packages/shared. Images travel through the asset endpoint rather than inside
 * the snapshot, so this only has to hold ink, text and shape items.
 */
export const MAX_WHITEBOARD_BYTES = 8 * 1024 * 1024;

export function validateViewport(viewport: Viewport): void {
  const valid =
    Number.isFinite(viewport.x) &&
    Number.isFinite(viewport.y) &&
    Number.isFinite(viewport.zoom) &&
    viewport.zoom > 0 &&
    viewport.zoom <= 16;
  if (!valid) throw badRequest("Board viewport is invalid");
}

/**
 * The snapshot is opaque, so the only thing worth checking is its size: an
 * unbounded blob would be written straight into the row on every autosave.
 *
 * Measured in **bytes**, not characters — `snapshot.len()` on the Rust side is
 * the UTF-8 length, and a snapshot full of CJK would otherwise pass here and
 * be refused there.
 */
export function validateWhiteboard(snapshot: string): void {
  if (Buffer.byteLength(snapshot, "utf8") > MAX_WHITEBOARD_BYTES) {
    throw badRequest("Whiteboard snapshot is too large");
  }
}

/** Every node and edge of one save, checked against the board it claims. */
export function validateDocument(
  boardId: string,
  nodes: readonly CanvasNode[],
  edges: readonly CanvasEdge[],
): void {
  const nodeIds = new Set(nodes.map((node) => node.id));
  const groupIds = new Set(
    nodes.filter((node) => node.type === "group").map((node) => node.id),
  );
  for (const node of nodes) {
    const kind = stringAt(node.data, "kind");
    const validIdentity =
      isUuid(node.id) &&
      isUuid(node.boardId) &&
      isRfc3339(node.createdAt) &&
      isRfc3339(node.updatedAt);
    const validGeometry =
      Number.isFinite(node.position?.x) &&
      Number.isFinite(node.position?.y) &&
      (node.size === undefined ||
        (Number.isFinite(node.size.width) &&
          Number.isFinite(node.size.height) &&
          node.size.width > 0 &&
          node.size.height > 0)) &&
      (node.expandedHeight === undefined ||
        (Number.isFinite(node.expandedHeight) && node.expandedHeight > 0));
    const validHeader =
      node.title !== "" &&
      [...node.title].length <= 160 &&
      isHexColor(node.color);
    // Labels are a filter, not a field: eight short chips at most, none of
    // them blank. The note is prose and only has an upper bound.
    const validAnnotations =
      node.labels.length <= MAX_NODE_LABELS &&
      node.labels.every((label) => {
        const trimmed = label.trim();
        return trimmed !== "" && [...trimmed].length <= MAX_NODE_LABEL_CHARS;
      }) &&
      [...node.note].length <= MAX_NODE_NOTE_CHARS;
    // A child may only live inside a group that is part of the same save.
    const validParent =
      node.parentId === undefined ||
      (node.parentId !== node.id &&
        groupIds.has(node.parentId) &&
        isUuid(node.parentId));
    if (
      node.boardId !== boardId ||
      !(NODE_TYPES as readonly string[]).includes(node.type) ||
      kind !== node.type ||
      !validIdentity ||
      !validGeometry ||
      !validHeader ||
      !validAnnotations ||
      !validParent ||
      !validNodeData(node)
    ) {
      throw badRequest("Board contains an invalid node");
    }
  }
  for (const edge of edges) {
    const validIdentity =
      isUuid(edge.id) &&
      isUuid(edge.boardId) &&
      isUuid(edge.source) &&
      isUuid(edge.target) &&
      isRfc3339(edge.createdAt) &&
      isRfc3339(edge.updatedAt);
    if (
      edge.boardId !== boardId ||
      !(EDGE_KINDS as readonly string[]).includes(edge.kind) ||
      !nodeIds.has(edge.source) ||
      !nodeIds.has(edge.target) ||
      !validIdentity
    ) {
      throw badRequest("Board contains an invalid or dangling edge");
    }
  }
}

/** The per-type `data` payload. An unknown type has no valid payload at all. */
export function validNodeData(node: CanvasNode): boolean {
  const data = node.data;
  switch (node.type) {
    case "terminal":
      return (
        optionalBoundedString(data, "cwd", 4_000) &&
        optionalBoundedString(data, "shell", 1_024) &&
        optionalUuidField(data, "sessionId") &&
        isAbsentOr(data, "lastExitCode", (value) => Number.isInteger(value)) &&
        isAbsentOr(data, "agent", validAgentBlock)
      );
    case "sticky":
      return boundedStringField(data, "content", MAX_STICKY_CONTENT);
    // The label is `node.title` and the tint is `node.color`; the payload
    // carries nothing else.
    case "group":
      return true;
    case "editor":
      return (
        stringField(data, "path") &&
        optionalBoundedString(data, "language", 40) &&
        isAbsentOr(data, "readonly", (value) => typeof value === "boolean")
      );
    case "diff":
      return (
        stringField(data, "repoPath") &&
        (DIFF_SCOPES as readonly string[]).includes(
          stringAt(data, "scope") ?? "",
        ) &&
        isAbsentOr(
          data,
          "paths",
          (value) =>
            Array.isArray(value) &&
            value.length <= 1_000 &&
            value.every((entry) => typeof entry === "string"),
        )
      );
    case "files":
      return stringField(data, "path");
    case "browser":
      return boundedStringField(data, "url", 4_000);
    // The node only references a plan owned elsewhere; the schedule, state and
    // results are read from there, never persisted onto the board.
    case "automation":
      return (
        stringField(data, "planId") &&
        stringField(data, "planWorkspaceId") &&
        stringField(data, "executionHostId") &&
        isAbsentOr(data, "scheduleKind", (value) =>
          (AUTOMATION_SCHEDULE_KINDS as readonly string[]).includes(
            value as string,
          ),
        ) &&
        optionalBoundedString(data, "timezone", 64)
      );
    // A read-only observation card. Identity is the observed session's, so a
    // title collision can never merge two different native jobs.
    case "agentActivity":
      return (
        isUuid(at(data, "sourceNodeId")) &&
        isAbsentOr(data, "source", (value) =>
          (AGENT_ACTIVITY_SOURCES as readonly string[]).includes(
            value as string,
          ),
        ) &&
        optionalBoundedString(data, "sessionId", 200) &&
        optionalBoundedString(data, "executionHostId", 200) &&
        optionalBoundedString(data, "nativeJobId", 200) &&
        isAbsentOr(
          data,
          "generation",
          (value) =>
            typeof value === "number" &&
            Number.isInteger(value) &&
            value >= 0 &&
            value < 2 ** 53,
        ) &&
        isAbsentOr(data, "nativeRecurrence", validNativeRecurrence)
      );
    default:
      return false;
  }
}

/**
 * `data.nativeRecurrence` on an activity card.
 *
 * Bounded and stored **verbatim**: it is evidence of what the machine was told
 * to do, and normalising it here would quietly drop the parts that make one
 * untranslatable. Only the dialect is constrained, because that is what tells
 * the panel which parser to try.
 */
function validNativeRecurrence(value: unknown): boolean {
  const rule = stringAt(value, "rule");
  return (
    (NATIVE_RECURRENCE_DIALECTS as readonly string[]).includes(
      stringAt(value, "dialect") ?? "",
    ) &&
    rule !== undefined &&
    rule !== "" &&
    [...rule].length <= 2_000 &&
    optionalBoundedString(value, "timezone", 64)
  );
}

/** `data.agent` on a terminal node — plan §5.1. */
function validAgentBlock(agent: unknown): boolean {
  const validId = validAgentId(stringAt(agent, "id") ?? "");
  const validPermission = isAbsentOr(agent, "permissionMode", (value) =>
    (PERMISSION_MODES as readonly string[]).includes(value as string),
  );
  // `after` is checked with key-presence, not null-coalescing, semantics: an
  // absent key is "launch immediately", while an explicit `null` is a client
  // that meant to send a list and sent nothing — which is not a launch order
  // anything should act on.
  const validPending = isAbsentOr(agent, "pendingLaunch", (value) => {
    if (!boundedStringField(value, "command", 4_000)) return false;
    if (!hasKey(value, "after")) return true;
    const after = at(value, "after");
    return (
      Array.isArray(after) &&
      after.length <= 32 &&
      after.every((id) => isUuid(id))
    );
  });
  // `account` mirrors AccountRef / CredentialBinding (S02). It is reserved:
  // stored when a client sends it, never interpreted here, and no secret may
  // hide in it — `credentialRef` is a name in a credential store.
  const validAccount = isAbsentOr(agent, "account", (value) => {
    const accountId = stringAt(value, "accountId");
    return (
      accountId !== undefined &&
      accountId !== "" &&
      accountId.length <= 120 &&
      optionalBoundedString(value, "providerId", 120) &&
      optionalBoundedString(value, "label", 200) &&
      optionalBoundedString(value, "credentialRef", 200)
    );
  });
  return (
    validId &&
    validPermission &&
    validPending &&
    validAccount &&
    optionalBoundedString(agent, "accountId", 120) &&
    optionalBoundedString(agent, "model", 120) &&
    optionalBoundedString(agent, "sessionId", 200) &&
    optionalBoundedString(agent, "initialCommand", 4_000)
  );
}

/** Built-in ids plus `custom:<id>` for user-defined CLIs. */
export function validAgentId(value: string): boolean {
  if ((BUILTIN_AGENT_IDS as readonly string[]).includes(value)) return true;
  if (!value.startsWith("custom:")) return false;
  const suffix = value.slice("custom:".length);
  return (
    suffix !== "" &&
    suffix.length <= 64 &&
    [...suffix].every(
      (character) =>
        /[A-Za-z0-9]/.test(character) || ".:_-".includes(character),
    )
  );
}

/* ------------------------------- field probes ------------------------------ */

function at(source: unknown, name: string): unknown {
  if (source === null || typeof source !== "object") return undefined;
  const value = (source as Record<string, unknown>)[name];
  return value;
}

function hasKey(source: unknown, name: string): boolean {
  return (
    source !== null &&
    typeof source === "object" &&
    Object.prototype.hasOwnProperty.call(source, name)
  );
}

function stringAt(source: unknown, name: string): string | undefined {
  const value = at(source, name);
  return typeof value === "string" ? value : undefined;
}

/**
 * `serde_json::Value::is_none_or(null)` semantics: an absent key and an
 * explicit `null` are both "not supplied", and anything else has to satisfy
 * the predicate.
 */
function isAbsentOr(
  source: unknown,
  name: string,
  predicate: (value: unknown) => boolean,
): boolean {
  const value = at(source, name);
  if (value === undefined || value === null) return true;
  return predicate(value);
}

/** Present, a string, and no longer than `max` **bytes**. */
function boundedStringField(
  source: unknown,
  name: string,
  max: number,
): boolean {
  const value = stringAt(source, name);
  return value !== undefined && Buffer.byteLength(value, "utf8") <= max;
}

function optionalBoundedString(
  source: unknown,
  name: string,
  max: number,
): boolean {
  return isAbsentOr(
    source,
    name,
    (value) =>
      typeof value === "string" && Buffer.byteLength(value, "utf8") <= max,
  );
}

function optionalUuidField(source: unknown, name: string): boolean {
  return isAbsentOr(source, name, (value) => isUuid(value));
}

/** Present, a string, non-empty and at most 4 000 bytes. */
function stringField(source: unknown, name: string): boolean {
  const value = stringAt(source, name);
  return (
    value !== undefined &&
    value !== "" &&
    Buffer.byteLength(value, "utf8") <= 4_000
  );
}
