/**
 * One browser connection's view of a server (design §2.2 `session`, §2.5).
 *
 * A session is not a server. It has its own `initialize` answer (replayed from
 * the one the host already got), its own id space, its own in-flight budget,
 * and its own grants. Everything a session sends passes four gates before a
 * byte reaches the process:
 *
 *  1. **Lifecycle methods are answered here.** `initialize`, `initialized`,
 *     `shutdown` and `exit` never reach a shared server — one tab closing must
 *     not shut down another tab's language support.
 *  2. **The method allowlist** (`./policy`), including the write gate.
 *  3. **Document bookkeeping**: only the owner of a uri produces `didChange`.
 *  4. **Rewriting**: `armadra:///<rel>` becomes `file://…`, and the id is
 *     renamed into this session's namespace.
 */

import { parseContentChanges } from "./documents";
import {
  REQUEST_FAILED,
  errorResponse,
  idText,
  namespaced,
  notification,
  parseMessage,
  resultResponse,
  type JsonObject,
  type JsonValue,
  type Message,
} from "./jsonrpc";
import { MAX_IN_FLIGHT } from "./limits";
import { Hub, withinMessageCeiling } from "./mux";
import { check, denialCode, denialMessage } from "./policy";

/** What a session sent, after this module is done with it. */
export type Outcome =
  /** Forwarded to the server. */
  | "forwarded"
  /** Answered here without touching the server. */
  | "answered"
  /**
   * Deliberately dropped: a follower's edit, or a notification the server
   * already knows about.
   */
  | "dropped"
  /** Refused; the session was told why. */
  | "refused";

function asObject(value: JsonValue | undefined): JsonObject | undefined {
  return value !== null &&
    value !== undefined &&
    typeof value === "object" &&
    !Array.isArray(value)
    ? value
    : undefined;
}

/** Handles one raw JSON-RPC message from a session's socket. */
export function handleSessionMessage(
  hub: Hub,
  sessionId: string,
  raw: Buffer | string,
): Outcome {
  const message = parseMessage(raw);
  if (message === undefined) return "refused";
  if (!withinMessageCeiling(raw)) {
    refuse(
      hub,
      sessionId,
      message,
      REQUEST_FAILED,
      "The request is larger than the language service accepts",
    );
    return "refused";
  }
  switch (message.method) {
    case "initialize":
      return answerInitialize(hub, sessionId, message);
    // The host already sent `initialized`; a second one would re-announce a
    // client the server has had since it started.
    case "initialized":
    case "exit":
      return "dropped";
    case "shutdown":
      hub.deliver(sessionId, resultResponse(message.id, null));
      return "answered";
    case "$/cancelRequest":
      return cancel(hub, sessionId, message);
    default:
      break;
  }

  const allowWrite = hub.sessions.get(sessionId)?.allowWrite ?? false;
  const denial = check(message.method, allowWrite);
  if (denial !== undefined) {
    if (message.kind === "request") {
      refuse(hub, sessionId, message, denialCode(denial), denialMessage(denial));
    }
    return "refused";
  }

  switch (message.method) {
    case "textDocument/didOpen":
      return didOpen(hub, sessionId, message);
    case "textDocument/didChange":
      return didChange(hub, sessionId, message);
    case "textDocument/didClose":
      return didClose(hub, sessionId, message);
    case "textDocument/didSave":
      fillSavedText(hub, message);
      break;
    default:
      break;
  }

  hub.rewriter.rewrite(message.value, "toHost");
  if (message.kind !== "request") {
    hub.write(message.value);
    return "forwarded";
  }
  return forwardRequest(hub, sessionId, message);
}

/**
 * The session's own `initialize` answer.
 *
 * It is the server's capabilities, not a negotiation: the host already did the
 * negotiating, and a second client cannot change what the server can do.
 * Answering from cache is what makes a restart invisible to the browser.
 */
function answerInitialize(
  hub: Hub,
  sessionId: string,
  message: Message,
): Outcome {
  hub.deliver(
    sessionId,
    resultResponse(message.id, {
      capabilities: hub.capabilities,
      serverInfo: { name: hub.serverId, version: "" },
    }),
  );
  return "answered";
}

/**
 * `$/cancelRequest` may only cancel this session's own request.
 *
 * Ids are namespaced per session precisely so this check is possible: without
 * it, one browser tab could cancel another tab's completion by guessing a
 * number, and both tabs count from 1.
 */
function cancel(hub: Hub, sessionId: string, message: Message): Outcome {
  const params = asObject(message.value["params"]);
  const target = params?.["id"];
  if (target === undefined) return "dropped";
  const wanted = idText(target);
  const found = [...hub.pending.entries()].find(
    ([, pending]) =>
      pending.sessionId === sessionId && idText(pending.clientId) === wanted,
  );
  if (found === undefined) {
    // Not this session's request — or already answered. Either way there is
    // nothing to cancel, and forwarding it would cancel somebody else's.
    return "dropped";
  }
  const [id, pending] = found;
  hub.pending.delete(id);
  // The budget is released here. A cancelled request's answer arrives with an
  // id nothing is waiting for and is dropped, so this is the only place that
  // can give the slot back — without it a session that cancels enough
  // completions would eventually be refused for being "too busy" while having
  // nothing outstanding at all.
  const sink = hub.sessions.get(pending.sessionId);
  if (sink !== undefined) sink.inFlight = Math.max(0, sink.inFlight - 1);
  hub.write(notification("$/cancelRequest", { id }));
  return "forwarded";
}

function didOpen(hub: Hub, sessionId: string, message: Message): Outcome {
  const document = asObject(asObject(message.value["params"])?.["textDocument"]);
  if (document === undefined) return "refused";
  const rawUri = document["uri"];
  const uri = typeof rawUri === "string" ? rawUri : "";
  const rawLanguage = document["languageId"];
  const languageId =
    typeof rawLanguage === "string" ? rawLanguage : hub.languageId;
  const rawText = document["text"];
  const text = typeof rawText === "string" ? rawText : "";

  hub.idleSince = undefined;
  const outcome = hub.documents.openDocument(sessionId, uri, languageId, text);
  if (outcome.kind === "followed") {
    // The server already has this buffer. The follower still gets diagnostics,
    // because those are broadcast to every session.
    return "dropped";
  }
  hub.write(
    notification("textDocument/didOpen", {
      textDocument: {
        uri: hub.hostUri(uri),
        languageId,
        version: outcome.version,
        text,
      },
    }),
  );
  return "forwarded";
}

function didChange(hub: Hub, sessionId: string, message: Message): Outcome {
  const params = asObject(message.value["params"]);
  if (params === undefined) return "refused";
  const rawUri = asObject(params["textDocument"])?.["uri"];
  const uri = typeof rawUri === "string" ? rawUri : "";
  const version = hub.documents.change(
    sessionId,
    uri,
    parseContentChanges(params),
  );
  if (version === undefined) {
    // A follower's edit, or a range the shadow text does not have. Either way
    // this session is not the document, and forwarding it would make the
    // server's copy disagree with the owner's (design §2.5).
    return "dropped";
  }
  hub.rewriter.rewrite(message.value, "toHost");
  const document = asObject(
    asObject(message.value["params"])?.["textDocument"],
  );
  // The host's version, never the client's: two tabs both count from 1.
  if (document !== undefined) document["version"] = version;
  hub.write(message.value);
  return "forwarded";
}

function didClose(hub: Hub, sessionId: string, message: Message): Outcome {
  const rawUri = asObject(
    asObject(message.value["params"])?.["textDocument"],
  )?.["uri"];
  const uri = typeof rawUri === "string" ? rawUri : "";
  const outcome = hub.documents.close(sessionId, uri);
  if (hub.documents.isEmpty()) hub.idleSince = Date.now();
  const hostUri = hub.hostUri(uri);
  switch (outcome.kind) {
    case "closed":
      hub.write(
        notification("textDocument/didClose", {
          textDocument: { uri: hostUri },
        }),
      );
      return "forwarded";
    // Ownership moved. The new owner's next incremental change is computed
    // against its own buffer, so the server is given that buffer in full
    // rather than being left with the departed owner's.
    case "ownerMoved":
      hub.write(
        notification("textDocument/didChange", {
          textDocument: { uri: hostUri, version: outcome.version },
          contentChanges: [{ text: outcome.text }],
        }),
      );
      return "forwarded";
    default:
      return "dropped";
  }
}

/**
 * `didSave` with `includeText`: the text comes from the shadow document, not
 * from the client, so what the server is told matches what the host believes.
 */
function fillSavedText(hub: Hub, message: Message): void {
  const params = asObject(message.value["params"]);
  if (params === undefined || params["text"] !== undefined) return;
  const rawUri = asObject(params["textDocument"])?.["uri"];
  const uri = typeof rawUri === "string" ? rawUri : "";
  const text = hub.documents.get(uri)?.text;
  if (text !== undefined) params["text"] = text;
}

/**
 * Renames the id into this session's namespace, records who is waiting, and
 * writes. The in-flight ceiling is checked here because this is the only place
 * a request is admitted.
 */
function forwardRequest(
  hub: Hub,
  sessionId: string,
  message: Message,
): Outcome {
  const clientId = message.id;
  if (clientId === undefined) return "refused";
  const sink = hub.sessions.get(sessionId);
  if (sink === undefined) return "refused";
  if (sink.inFlight >= MAX_IN_FLIGHT) {
    refuse(
      hub,
      sessionId,
      message,
      REQUEST_FAILED,
      "Too many language requests are already in flight",
    );
    return "refused";
  }
  hub.sequence += 1;
  const id = namespaced(hub.sequence, sessionId);
  sink.inFlight += 1;
  hub.pending.set(id, {
    sessionId,
    clientId,
    method: message.method,
    sentAt: Date.now(),
  });
  message.value["id"] = id;
  hub.write(message.value);
  return "forwarded";
}

function refuse(
  hub: Hub,
  sessionId: string,
  message: Message,
  code: number,
  text: string,
): void {
  if (message.kind === "notification") return;
  hub.deliver(sessionId, errorResponse(message.id, code, text));
}
