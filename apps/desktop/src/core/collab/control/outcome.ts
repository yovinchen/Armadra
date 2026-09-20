/**
 * What a control verb answers with.
 *
 * Ported from the `Outcome` type in the pre-merge implementation.
 * Two shapes, and the distinction is load-bearing: most verbs answer
 * `{ok, message, result}` — prose the model reads plus a small object it can
 * branch on — but two of them have a reply shape that *is* the answer. The
 * mailbox protocol and a handoff bundle are rendered as the whole body, so the
 * agent reads `protocol` and `id` without unwrapping a `result` key that means
 * nothing to it.
 */
export interface Outcome {
  readonly message: string;
  readonly result?: unknown;
  readonly warning?: string;
  /** A verb whose own reply shape is the answer; rendered as the whole body. */
  readonly raw?: Record<string, unknown>;
}

export function result(message: string, value: unknown): Outcome {
  return { message, result: value };
}

export function raw(body: Record<string, unknown>, message: string): Outcome {
  return { message, raw: body };
}

export function warn(outcome: Outcome, warning: string): Outcome {
  return { ...outcome, warning };
}

export function outcomeBody(outcome: Outcome): Record<string, unknown> {
  if (outcome.raw !== undefined) return outcome.raw;
  const body: Record<string, unknown> = { ok: true, message: outcome.message };
  if (outcome.result !== undefined) body.result = outcome.result;
  if (outcome.warning !== undefined) body.warning = outcome.warning;
  return body;
}
