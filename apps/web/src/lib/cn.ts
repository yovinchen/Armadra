import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * 合并 class：先用 clsx 展开条件表达式，再用 tailwind-merge 消解冲突。
 *
 * 冲突消解是必须的——`src/ui/*` 的组件都接受 `className` 覆盖，
 * 没有 twMerge 的话 `<Button className="px-6">` 会和内置的 `px-3` 同时存在，
 * 结果取决于 CSS 里的书写顺序而不是调用者的意图。
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
