/**
 * The seam between the hook surface and the collaboration domain.
 *
 * The hook routes `/context-link/{verb}`, `/control/{verb}` and
 * `/browser/{verb}` are *this* module's door — they carry the hook service's
 * own credentials and its own body limit — but what a verb *means* belongs to
 * the agent and browser domains, which land separately. So the door is here
 * and the verb table is registered into it.
 *
 * Until a dispatcher registers, an authenticated caller gets a 501 that names
 * the surface rather than a 403: the difference matters to whoever is holding
 * a hook client and asking whether their token works.
 */

export interface CollabCaller {
  readonly nodeId: string;
  /** Whether the caller presented this core's own per-node token. */
  readonly verified: boolean;
}

export interface CollabRequest {
  readonly verb: string;
  readonly caller: CollabCaller;
  readonly args: Readonly<Record<string, unknown>>;
  /** The caller asked for prose rather than JSON (`Accept: text/plain`). */
  readonly wantsText: boolean;
}

export type CollabAnswer =
  | { readonly kind: "text"; readonly status: number; readonly body: string }
  | { readonly kind: "json"; readonly status: number; readonly body: unknown };

export type CollabDispatcher = (
  request: CollabRequest,
) => Promise<CollabAnswer> | CollabAnswer;

const dispatchers = new Map<string, CollabDispatcher>();

/**
 * Registers the handler for one hook-surface family — `context-link`,
 * `control` or `browser`. Registering twice replaces, so a domain that
 * reinstalls (a test, a restart in-process) does not stack handlers.
 */
export function registerCollabDispatcher(
  family: string,
  dispatcher: CollabDispatcher,
): () => void {
  dispatchers.set(family, dispatcher);
  return () => {
    if (dispatchers.get(family) === dispatcher) dispatchers.delete(family);
  };
}

export function collabDispatcher(
  family: string,
): CollabDispatcher | undefined {
  return dispatchers.get(family);
}
