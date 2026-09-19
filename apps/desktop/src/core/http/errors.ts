/**
 * Every failure the core reports, in one shape.
 *
 * `{ code, message }` is contractual (contract §5.1): the front end switches on
 * `code` and shows `message`, and 347 zod schemas in `packages/shared` are
 * written against exactly this. Nothing here may grow a third key.
 */
export interface CoreError {
  readonly code: string;
  readonly message: string;
}

export interface ErrorResponse {
  readonly status: number;
  readonly body: CoreError;
}

export function coreError(
  status: number,
  code: string,
  message: string,
): ErrorResponse {
  return { status, body: { code, message } };
}

export const notFound = (path: string): ErrorResponse =>
  coreError(404, "not_found", `没有这个接口：${path}`);

export const methodNotAllowed = (method: string, path: string): ErrorResponse =>
  coreError(405, "method_not_allowed", `${path} 不接受 ${method}`);

export const badRequest = (message: string): ErrorResponse =>
  coreError(400, "bad_request", message);

export const forbidden = (message: string): ErrorResponse =>
  coreError(403, "forbidden", message);

export const internal = (message: string): ErrorResponse =>
  coreError(500, "internal", message);

/**
 * The answer every route this build has not written yet gives.
 *
 * 501 rather than 404 on purpose. During the changeover the front end talks to
 * whichever core the switch selected, and a 404 reads as "you asked for
 * something that does not exist" — indistinguishable from a typo in a URL. A
 * 501 that names the feature and the phase it lands in says what actually
 * happened, and is what the UI degrades on.
 */
export function notImplemented(feature: string, phase: number): ErrorResponse {
  return coreError(501, "not_implemented", `${feature}（R${phase}）`);
}
