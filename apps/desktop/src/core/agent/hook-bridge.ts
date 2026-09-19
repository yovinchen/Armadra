import type { DatabaseSync } from "node:sqlite";
import { controlDispatcher } from "../collab/control";
import { type Caller, loadNode } from "../collab/nodes";
import {
  type CollabAnswer,
  type CollabCaller,
  type CollabRequest,
  registerCollabDispatcher,
} from "../hook/collab";

/**
 * Plugs the collaboration verbs into the hook surface.
 *
 * The hook server authenticates a request and hands over `{ nodeId, verified }`;
 * the verbs want a `Caller` — the node row plus a verdict. This is the one
 * place that turns one into the other, so the hook domain never imports the
 * verbs and the verb tables never learn about tokens. A `forged` caller is
 * refused at the door and never reaches here, which is why the verdict only
 * has two values on this side.
 *
 * Two families are registered: `context-link` answers prose (the client prints
 * it verbatim), `control` answers JSON (the client renders it). `browser` is
 * registered by the browser domain with the same helper.
 */
export function installHookBridge(
  database: DatabaseSync,
  contextLink: (
    caller: Caller,
    verb: string,
    args: Readonly<Record<string, unknown>>,
  ) => Promise<string>,
): () => void {
  const releaseContext = registerCollabDispatcher(
    "context-link",
    async (request) => {
      const caller = resolveCaller(database, request.caller);
      if (caller === undefined) return unknownCaller(request);
      return {
        kind: "text",
        status: 200,
        body: await contextLink(caller, request.verb, request.args),
      };
    },
  );
  const releaseControl = registerCollabDispatcher(
    "control",
    async (request) => {
      const dispatcher = controlDispatcher();
      if (dispatcher === undefined) {
        return {
          kind: "json",
          status: 503,
          body: { code: "unavailable", message: "画布动词尚未装配" },
        };
      }
      const caller = resolveCaller(database, request.caller);
      if (caller === undefined) return unknownCaller(request);
      const outcome = await dispatcher.dispatch(
        request.verb,
        caller,
        request.args,
      );
      return outcome.ok
        ? { kind: "json", status: 200, body: outcome.body }
        : {
            kind: "json",
            status: outcome.status,
            body: { code: outcome.code, message: outcome.message },
          };
    },
  );
  return () => {
    releaseContext();
    releaseControl();
  };
}

export function resolveCaller(
  database: DatabaseSync,
  caller: CollabCaller,
): Caller | undefined {
  const node = loadNode(database, caller.nodeId);
  if (node === undefined) return undefined;
  return { node, verdict: caller.verified ? "verified" : "legacy" };
}

/**
 * The same sentence whether the node never existed or was deleted a moment
 * ago — the caller learns nothing about which.
 */
function unknownCaller(request: CollabRequest): CollabAnswer {
  const message = `连接的节点里没有叫「${request.caller.nodeId}」的。`;
  return request.wantsText
    ? { kind: "text", status: 404, body: message }
    : { kind: "json", status: 404, body: { code: "not_found", message } };
}
