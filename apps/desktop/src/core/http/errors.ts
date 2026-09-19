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
 * 表里有、这个构建没写的路由答的那一句。
 *
 * 501 而不是 404，是因为 404 读起来是「你要的东西不存在」——和一个拼错的 URL
 * 分不开。501 说的是「这条路在契约里，这个构建还没写」，页面据此降级。
 */
export function notImplemented(path: string): ErrorResponse {
  return coreError(501, "not_implemented", `未实现：${path}`);
}
