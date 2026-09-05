import type { BoardDocument } from "@armadra/shared";

/**
 * 「这份文档已经在 editor 里了」的标记（tldraw 计划 §3 规则 1）。
 *
 * `use-store-sync` 判断「文档 → editor」要不要投影，靠的是文档**对象身份**：
 * 不是我写出去的那一份，就当成外面换了一整份（`setDocument`）。但 store 的
 * 每个动作都会既改文档、又直接写 editor，如果不在这里登记一下，那些动作
 * 也会被当成外来文档，于是每敲一个字都要把整块看板重新投影一遍。
 *
 * 漏登记是安全的：最坏情况只是多做一次幂等的投影。
 */

let pushed: BoardDocument | null = null;

export function markPushed(document: BoardDocument | null): void {
  pushed = document;
}

export function isPushed(document: BoardDocument): boolean {
  return pushed === document;
}
