/**
 * ACP event → timeline model.
 *
 * The runtime normalises every `sessionUpdate` into the small tagged union
 * below (docs/redesign-plan.md §3, `apps/runtime/src/acp.rs::normalize_update`).
 * Reducing it here keeps `AcpSurface` a pure renderer and makes the tricky
 * parts — tool rows updating in place by `toolCallId`, plan replacement, the
 * 240-item cap — unit testable.
 */

export const TIMELINE_CAP = 240;

export type ToolStatus = "pending" | "in_progress" | "completed" | "failed";

export interface PlanEntry {
  content: string;
  status: string;
}

export interface PermissionOption {
  optionId: string;
  name: string;
  kind?: string;
}

export type TimelineItem =
  | { id: number; kind: "user"; text: string }
  | { id: number; kind: "assistant"; text: string }
  | { id: number; kind: "thinking"; text: string }
  | { id: number; kind: "status"; text: string }
  | {
      id: number;
      kind: "tool";
      toolCallId: string;
      title: string;
      detail: string | null;
      toolKind: string | null;
      status: ToolStatus;
    }
  | { id: number; kind: "plan"; entries: PlanEntry[] }
  | {
      id: number;
      kind: "permission";
      requestId: string;
      title: string;
      command: string;
      options: PermissionOption[];
      /** `null` while pending, otherwise the chosen option kind or id. */
      decision: string | null;
    };

export type AcpUpdate =
  | { kind: "message"; text: string }
  | { kind: "user"; text: string }
  | { kind: "thinking"; text: string }
  | {
      kind: "tool";
      toolCallId: string;
      title: string;
      status: ToolStatus;
      toolKind: string | null;
      detail: string | null;
    }
  | { kind: "plan"; entries: PlanEntry[] }
  | { kind: "usage"; inputTokens: number; outputTokens: number };

export type TimelineEvent =
  | { type: "update"; update: AcpUpdate }
  | { type: "status"; text: string }
  | {
      type: "permission";
      requestId: string;
      title: string;
      command: string;
      options: PermissionOption[];
    }
  | { type: "permission_resolved"; requestId: string; resolution: string };

/** Reads one runtime `update` payload defensively; unknown shapes are dropped. */
export function parseUpdate(value: unknown): AcpUpdate | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const text = typeof record.text === "string" ? record.text : "";
  switch (record.kind) {
    case "message":
    case "user":
    case "thinking":
      return text ? { kind: record.kind, text } : null;
    case "tool": {
      if (typeof record.toolCallId !== "string") return null;
      const status = record.status;
      return {
        kind: "tool",
        toolCallId: record.toolCallId,
        title: typeof record.title === "string" ? record.title : "工具调用",
        status: isToolStatus(status) ? status : "pending",
        toolKind: typeof record.toolKind === "string" ? record.toolKind : null,
        detail: typeof record.detail === "string" ? record.detail : null,
      };
    }
    case "plan": {
      if (!Array.isArray(record.entries)) return null;
      const entries = record.entries.flatMap((entry) => {
        if (!entry || typeof entry !== "object") return [];
        const item = entry as Record<string, unknown>;
        return typeof item.content === "string"
          ? [
              {
                content: item.content,
                status: typeof item.status === "string" ? item.status : "",
              },
            ]
          : [];
      });
      return { kind: "plan", entries };
    }
    case "usage":
      return {
        kind: "usage",
        inputTokens: numeric(record.inputTokens),
        outputTokens: numeric(record.outputTokens),
      };
    default:
      return null;
  }
}

/** Extracts the option list of a `permission` event. */
export function parsePermissionOptions(request: unknown): PermissionOption[] {
  if (!request || typeof request !== "object") return [];
  const options = (request as Record<string, unknown>).options;
  if (!Array.isArray(options)) return [];
  return options.flatMap((option) => {
    if (!option || typeof option !== "object") return [];
    const item = option as Record<string, unknown>;
    if (typeof item.optionId !== "string") return [];
    return [
      {
        optionId: item.optionId,
        name: typeof item.name === "string" ? item.name : item.optionId,
        kind: typeof item.kind === "string" ? item.kind : undefined,
      },
    ];
  });
}

/** `toolCall.title` when present, so the permission card names the operation. */
export function parsePermissionTitle(request: unknown): string {
  const toolCall = readToolCall(request);
  const title = toolCall?.title;
  return typeof title === "string" ? title : "";
}

/**
 * Best-effort command line for the mono box on the permission card:
 * `rawInput.command`, then a joined `rawInput.args`, then the tool title.
 */
export function parsePermissionCommand(request: unknown): string {
  const toolCall = readToolCall(request);
  const rawInput = toolCall?.rawInput;
  if (rawInput && typeof rawInput === "object") {
    const input = rawInput as Record<string, unknown>;
    if (typeof input.command === "string" && input.command.trim())
      return input.command;
    if (Array.isArray(input.command))
      return input.command.filter((part) => typeof part === "string").join(" ");
    for (const key of ["cmd", "path", "file_path", "filePath", "url"]) {
      const value = input[key];
      if (typeof value === "string" && value.trim()) return value;
    }
  }
  return parsePermissionTitle(request);
}

/**
 * Folds one event into the timeline. Streaming `message` / `thinking` chunks
 * append to the trailing bubble of the same kind; tool rows are keyed by
 * `toolCallId`; a `plan` replaces the previous plan checklist.
 */
export function reduceTimeline(
  items: TimelineItem[],
  event: TimelineEvent,
  nextId: () => number,
): TimelineItem[] {
  const capped = (next: TimelineItem[]) =>
    next.length > TIMELINE_CAP ? next.slice(next.length - TIMELINE_CAP) : next;

  if (event.type === "status") {
    return capped([
      ...items,
      { id: nextId(), kind: "status", text: event.text },
    ]);
  }

  if (event.type === "permission") {
    const existing = items.find(
      (item) =>
        item.kind === "permission" && item.requestId === event.requestId,
    );
    if (existing) return items;
    return capped([
      ...items,
      {
        id: nextId(),
        kind: "permission",
        requestId: event.requestId,
        title: event.title,
        command: event.command,
        options: event.options,
        decision: null,
      },
    ]);
  }

  if (event.type === "permission_resolved") {
    return items.map((item) =>
      item.kind === "permission" && item.requestId === event.requestId
        ? { ...item, decision: event.resolution }
        : item,
    );
  }

  const update = event.update;
  switch (update.kind) {
    case "usage":
      return items;
    case "message":
    case "user":
    case "thinking": {
      const kind =
        update.kind === "message"
          ? ("assistant" as const)
          : update.kind === "user"
            ? ("user" as const)
            : ("thinking" as const);
      const last = items.at(-1);
      if (last && last.kind === kind) {
        return [
          ...items.slice(0, -1),
          { ...last, text: last.text + update.text },
        ];
      }
      return capped([...items, { id: nextId(), kind, text: update.text }]);
    }
    case "tool": {
      const index = items.findIndex(
        (item) => item.kind === "tool" && item.toolCallId === update.toolCallId,
      );
      const row: TimelineItem = {
        id: index >= 0 ? items[index]!.id : nextId(),
        kind: "tool",
        toolCallId: update.toolCallId,
        title: update.title,
        detail: update.detail,
        toolKind: update.toolKind,
        status: update.status,
      };
      if (index >= 0) {
        const next = [...items];
        next[index] = row;
        return next;
      }
      return capped([...items, row]);
    }
    case "plan": {
      const index = items.findIndex((item) => item.kind === "plan");
      const row: TimelineItem = {
        id: index >= 0 ? items[index]!.id : nextId(),
        kind: "plan",
        entries: update.entries,
      };
      if (index >= 0) {
        const next = [...items];
        next[index] = row;
        return next;
      }
      return capped([...items, row]);
    }
  }
}

/** True while any permission card is still awaiting a decision. */
export function hasPendingPermission(items: TimelineItem[]): boolean {
  return items.some(
    (item) => item.kind === "permission" && item.decision === null,
  );
}

function readToolCall(request: unknown): Record<string, unknown> | null {
  if (!request || typeof request !== "object") return null;
  const toolCall = (request as Record<string, unknown>).toolCall;
  return toolCall && typeof toolCall === "object"
    ? (toolCall as Record<string, unknown>)
    : null;
}

function isToolStatus(value: unknown): value is ToolStatus {
  return (
    value === "pending" ||
    value === "in_progress" ||
    value === "completed" ||
    value === "failed"
  );
}

function numeric(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
