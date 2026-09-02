import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";

import { runtimeApi } from "../api/client";
import {
  COMMANDS,
  useKeybindings,
  type KeybindingHandlers,
} from "../keybindings";
import { toKeymap } from "../panels/settings/keymap";
import type { CommandDispatch } from "./commands";

/**
 * 全应用唯一的一处 `useKeybindings`（§13.5）。
 * 每条命令都接到 `dispatch.run`，避免各处再各自监听 keydown。
 *
 * 用户在设置 → 快捷键里改过的键位存在 Runtime 的 `settings.keymap` 里，
 * 这里跟着同一个 `["settings"]` 查询读回来：设置页保存后缓存立刻更新，
 * 新键位下一帧就生效，不需要重启。
 */
export function useAppKeybindings(dispatch: CommandDispatch): void {
  const settings = useQuery({
    queryKey: ["settings"],
    queryFn: runtimeApi.settings,
    retry: false,
    staleTime: 30_000,
  });
  const keymap = useMemo(
    () => toKeymap(settings.data?.keymap),
    [settings.data],
  );

  const handlers = useMemo<KeybindingHandlers>(() => {
    const map: KeybindingHandlers = {};
    for (const command of COMMANDS) {
      map[command.id] = () => dispatch.run(command.id);
    }
    return map;
  }, [dispatch]);

  useKeybindings(handlers, { keymap });
}
