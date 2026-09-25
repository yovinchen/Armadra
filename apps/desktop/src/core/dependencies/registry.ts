import type { DependencyService } from "./service";

/**
 * 装配好的那个服务。
 *
 * 单独一个模块、只 import 类型：`open-agent` 在协作域里，协作域又是依赖服务
 * 要借的东西，直接从 `index.ts` 取会绕成一个环。
 */
let current: DependencyService | undefined;

export function setDependencyService(
  service: DependencyService | undefined,
): void {
  current = service;
}

export function dependencyService(): DependencyService | undefined {
  return current;
}
