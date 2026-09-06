// 每一步的记账。检查本身在 `agent/stages/` 下，按阶段一个文件；这里只负责把
// 结果攒起来并按同一种格式说出来。

export const results = [];

export function step(name, ok, detail = "") {
  results.push({ name, ok });
  const mark = ok ? "  ok  " : " FAIL ";
  console.log(`${mark}${name}${detail ? `  — ${detail}` : ""}`);
}
export function note(text) {
  console.log(`  note  ${text}`);
}
export function refusal(value) {
  return value?.error
    ? ` (${value.error.failure} HTTP ${value.error.httpStatus})`
    : "";
}
