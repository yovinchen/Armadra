/**
 * Method → required grant (design §3.1).
 *
 * The list is closed. A method that is not named here is refused with
 * `-32601`, which means a server that grows a new capability cannot be driven
 * through this proxy until somebody adds it deliberately. That is the point:
 * an allowlist that falls through to "allow" is a passthrough with extra
 * steps, and a passthrough would let a browser ask a language server to run
 * `workspace/executeCommand`.
 */

import { METHOD_NOT_FOUND, type JsonValue } from "./jsonrpc";
import { reason } from "./limits";

/** What a method needs before it may reach the server. */
export type Requirement =
  /** The workspace's `execute` grant, which every session already has. */
  | "execute"
  /** `execute` and `write`. These change the buffer or change files. */
  | "write"
  /** Never allowed, whatever the workspace grants. */
  | "never";

/** Read-only traffic: it asks the server questions about text it already has. */
const READ_METHODS: readonly string[] = [
  "initialized",
  "exit",
  "shutdown",
  "textDocument/didOpen",
  "textDocument/didChange",
  "textDocument/didClose",
  "textDocument/didSave",
  "textDocument/completion",
  "completionItem/resolve",
  "textDocument/hover",
  "textDocument/signatureHelp",
  "textDocument/definition",
  "textDocument/typeDefinition",
  "textDocument/implementation",
  "textDocument/declaration",
  "textDocument/references",
  "textDocument/documentSymbol",
  "textDocument/documentHighlight",
  "textDocument/codeAction",
  "textDocument/foldingRange",
  "workspace/symbol",
  "workspaceSymbol/resolve",
  "$/cancelRequest",
  "$/setTrace",
];

/**
 * Traffic that produces an edit. The editor is read-only without the write
 * grant anyway, so refusing these keeps the two consistent instead of offering
 * a rename that could never be applied.
 */
const WRITE_METHODS: readonly string[] = [
  "textDocument/formatting",
  "textDocument/rangeFormatting",
  "textDocument/onTypeFormatting",
  "textDocument/prepareRename",
  "textDocument/rename",
  "codeAction/resolve",
];

/**
 * Refused in every workspace. `executeCommand` runs whatever the server feels
 * like on the execution host, and a code action carrying a `command` is the
 * same thing wearing a different hat (design §6.2).
 */
const NEVER_METHODS: readonly string[] = [
  "workspace/executeCommand",
  "window/showDocument",
  "workspace/applyEdit",
  // `initialize` is answered by the Manager from its cached result; a session
  // that sends its own would re-handshake a shared server.
  "initialize",
];

export function requirement(method: string): Requirement {
  if (NEVER_METHODS.includes(method)) return "never";
  if (WRITE_METHODS.includes(method)) return "write";
  if (READ_METHODS.includes(method)) return "execute";
  // Unknown is refused, not allowed. Nothing falls through.
  return "never";
}

export type Denial = "readOnly" | "notAllowed";

/** Whether one session may send one method, and why not when it may not. */
export function check(method: string, allowWrite: boolean): Denial | undefined {
  switch (requirement(method)) {
    case "execute":
      return undefined;
    case "write":
      return allowWrite ? undefined : "readOnly";
    case "never":
      return "notAllowed";
  }
}

export function denialCode(_denial: Denial): number {
  return METHOD_NOT_FOUND;
}

export function denialMessage(denial: Denial): string {
  return denial === "readOnly"
    ? "This workspace is opened read-only"
    : "This language method is not available";
}

/**
 * Server-initiated requests the Manager answers itself, so they never reach
 * the browser (design §2.2 `mux`).
 */
export const SERVER_REQUESTS: readonly string[] = [
  "workspace/configuration",
  "client/registerCapability",
  "client/unregisterCapability",
  "window/workDoneProgress/create",
  "workspace/workspaceFolders",
  "workspace/applyEdit",
];

/**
 * A code action that carries a `command` is not applied in the first version:
 * running it would be `workspace/executeCommand` by another route. Actions
 * that carry only an `edit` are kept.
 */
export function codeActionIsOffered(action: JsonValue): boolean {
  if (action === null || typeof action !== "object" || Array.isArray(action)) {
    return true;
  }
  return action["command"] === undefined || action["edit"] !== undefined;
}

/**
 * The gate a server's own `workspace/applyEdit` passes.
 *
 * It is the same gate a client-initiated rename passes, and it is spelled
 * through the same table so the two cannot drift. `workspace/applyEdit` also
 * appears in the never list, and that is not a contradiction: a *session* may
 * not send one — a browser must not be able to forge an edit in the server's
 * name — while a server may ask for one and be answered honestly. Direction,
 * not rule.
 */
export function serverEditAllowed(allowWrite: boolean): Denial | undefined {
  return check("textDocument/rename", allowWrite);
}

/** A workspace's grants as the language service reads them. */
export interface WorkspaceGrants {
  readonly write: boolean;
  readonly execute: boolean;
}

/**
 * What a change of grants means for the servers already running (design
 * §1.3).
 *
 *  * `stop` — the workspace is gone or lost `execute`. A running server is a
 *    process started under a grant that no longer exists; it is stopped now,
 *    with the reason the page shows, not left to the idle sweep.
 *  * `readOnly` — `execute` stays but `write` went. The server may keep
 *    answering questions; the sessions lose the edit methods.
 *  * `keep` — nothing the language service depends on changed for the worse.
 */
export type GrantChange =
  | { readonly kind: "stop"; readonly reason: string }
  | { readonly kind: "readOnly" }
  | { readonly kind: "keep" };

export function grantChange(
  grants: WorkspaceGrants | null,
  movedTo?: string,
): GrantChange {
  if (grants === null) return { kind: "stop", reason: reason.WORKSPACE_CLOSED };
  // 换了执行主机或根目录：跑着的服务器读的是旧根。搬到别的机器上时说
  // `unsupported_remote`（远端不起语言服务），留在本机只是换了目录就按关闭说，
  // 下一次开会话会在新根上重新起。
  if (movedTo !== undefined) {
    return {
      kind: "stop",
      reason:
        movedTo === "" ? reason.WORKSPACE_CLOSED : reason.UNSUPPORTED_REMOTE,
    };
  }
  if (!grants.execute) {
    return { kind: "stop", reason: reason.EXECUTION_NOT_GRANTED };
  }
  if (!grants.write) return { kind: "readOnly" };
  return { kind: "keep" };
}
