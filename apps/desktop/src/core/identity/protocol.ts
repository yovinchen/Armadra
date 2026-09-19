/**
 * 这台 core 报出去的协议版本与帧上限。
 *
 * `GET /api/identity/hello` 答的就是这三个数（`docs/contracts/core-json-api.md`
 * §3）。R7 之前它们住在 `packages/protocol` 里，因为三端共用一份 `.proto`；现在
 * 只剩一端，所以它们住在报它们的那个域里。
 */

/** major 变了就是不兼容：页面看到一个不认识的 major 必须停下，而不是猜。 */
export const PROTOCOL_MAJOR = 1;
/** minor 只增不减，且只加东西。页面按 `min(自己的, core 的)` 谈。 */
export const PROTOCOL_MINOR = 2;
/** 一次请求体的上限。超出是调用方能应对的错误，不是一段被截断的正文。 */
export const MAX_FRAME_BYTES = 1_048_576;
