import * as React from "react";
import { shellDialect, type ShellDialect } from "@armadra/shared";

import { systemApi } from "@/api/system";
import type { PathRules } from "@/lib/host-path";

/**
 * core 那台机器是什么平台、终端缺省跑哪个 shell（`/api/health` 的
 * `platform` / `defaultShell`）。
 *
 * 页面是个浏览器，看不见 core 的机器：本机路径按 Windows 还是 POSIX 的规则
 * 校验，节点没指定 shell 时启动行按哪种方言引用，都只能问 core。只问一次——
 * core 起来之后这两样不会变；问不到（旧 core、网络断了）时两样都不知道，调用
 * 方按 POSIX 处理，下次再有人要时再问。
 */
export interface CoreHost {
  readonly platform?: string;
  readonly defaultShell?: string;
}

let host: CoreHost = {};
let probe: Promise<void> | undefined;
const listeners = new Set<() => void>();

function publish(): void {
  for (const listener of listeners) listener();
}

/** 发起那一次询问；已经问过或正在问时什么都不做。 */
export function ensureCoreHost(): void {
  if (probe !== undefined) return;
  probe = systemApi
    .health()
    .then((health) => {
      host = {
        ...(health.platform ? { platform: health.platform } : {}),
        ...(health.defaultShell ? { defaultShell: health.defaultShell } : {}),
      };
      publish();
    })
    .catch(() => {
      probe = undefined;
    });
}

export function coreHost(): CoreHost {
  return host;
}

/** core 本机路径的校验规则（`lib/host-path.ts`）。还不知道时按 POSIX。 */
export function localPathRules(current: CoreHost = host): PathRules {
  return current.platform === "win32" ? "windows" : "posix";
}

/** 节点没指定 shell 时，终端里那个 shell 的方言。 */
export function defaultShellDialect(): ShellDialect {
  return shellDialect(host.defaultShell);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function snapshot(): CoreHost {
  return host;
}

/** 组件里读：第一次用时顺手发起询问，答案到了重渲染。 */
export function useCoreHost(): CoreHost {
  React.useEffect(() => {
    ensureCoreHost();
  }, []);
  return React.useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** 测试用：直接给出答案，或者回到还没问过的状态。 */
export function setCoreHost(next: CoreHost | undefined): void {
  host = next ?? {};
  probe = next === undefined ? undefined : Promise.resolve();
  publish();
}
