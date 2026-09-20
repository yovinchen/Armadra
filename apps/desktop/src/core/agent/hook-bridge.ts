import type { DatabaseSync } from "node:sqlite";
import { browserVerbs } from "../browser";
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
 * Three families are registered: `context-link` and `browser` answer prose
 * (the client prints it verbatim), `control` answers JSON (the client renders
 * it). The browser verbs themselves live in the browser domain; this only hands
 * them the `Caller` and the raw `args`, as it does for the other two.
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
      try {
        return {
          kind: "text",
          status: 200,
          body: await contextLink(caller, request.verb, request.args),
        };
      } catch (error) {
        // The verbs refuse by throwing; the browser family's dispatcher
        // already returns its refusals, which is why only this one needed it.
        // Uncaught, every refusal reached the hook server and came back as a
        // bare 500 — the agent was told "the core failed" instead of "nothing
        // is linked to you" or "that node has no terminal", and there is no
        // way to act on the first sentence.
        const refusal = asRefusal(error);
        if (refusal === undefined) throw error;
        return {
          kind: "text",
          status: refusal.status,
          body: `${refusal.message}\n`,
        };
      }
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
  const releaseBrowser = registerCollabDispatcher(
    "browser",
    async (request) => {
      const verbs = browserVerbs();
      if (verbs === undefined) {
        return { kind: "text", status: 503, body: "浏览器动词尚未装配\n" };
      }
      const caller = resolveCaller(database, request.caller);
      if (caller === undefined) return unknownCaller(request);
      const outcome = await verbs.dispatch(caller, request.verb, request.args);
      // Prose either way: a refusal is a sentence the agent reads, and the hook
      // client prints whatever comes back without looking at the status.
      return outcome.ok
        ? { kind: "text", status: 200, body: outcome.body }
        : {
            kind: "text",
            status: outcome.status,
            body: `${outcome.message}\n`,
          };
    },
  );
  return () => {
    releaseContext();
    releaseControl();
    releaseBrowser();
  };
}

/**
 * A refusal the verbs threw, or `undefined` for a genuine failure.
 *
 * Matched by shape rather than by `instanceof`: `Refusal` and `Refused` are
 * two classes with the same two fields, and a third would otherwise have to
 * be remembered here. Anything else is a bug and keeps going up, where it
 * becomes the 500 it should be.
 */
function asRefusal(
  error: unknown,
): { status: number; message: string } | undefined {
  if (!(error instanceof Error)) return undefined;
  const status = (error as { status?: unknown }).status;
  if (typeof status !== "number" || status < 400 || status > 599) {
    return undefined;
  }
  return { status, message: error.message };
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
