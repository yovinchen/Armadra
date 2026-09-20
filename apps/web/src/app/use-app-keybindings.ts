import { useEffect, useMemo, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { runtimeApi } from "../api/client";
import {
  COMMANDS,
  GLOBAL_SHORTCUT_ACTIONS,
  globalBindings,
  onGlobalShortcut,
  setActiveKeymap,
  useGlobalShortcuts,
  useKeybindings,
  type KeybindingHandlers,
} from "../keybindings";
import { useDeviceKeymapStore } from "../panels/settings/device-keymap-store";
import { keymapMigrationPatch, resolveKeymap } from "../panels/settings/keymap";
import { activeGlobalLayer } from "../panels/settings/keymap-profiles";
import type { CommandDispatch } from "./commands";

/**
 * 全应用唯一的一处 `useKeybindings`（§13.5）。
 * 每条命令都接到 `dispatch.run`，避免各处再各自监听 keydown。
 *
 * 键位是三层合并的结果（终端宿主设计 §10）：内置默认 → Runtime
 * `settings.keymap` 里当前配置档的全局覆盖 → 本设备覆盖。前者跟着同一个
 * `["settings"]` 查询读回来，设置页保存后缓存立刻更新；后者在 localStorage
 * 里，两边读同一个 store，所以改完下一帧就生效，不需要重启。
 */
export function useAppKeybindings(dispatch: CommandDispatch): void {
  const client = useQueryClient();
  const settings = useQuery({
    queryKey: ["settings"],
    queryFn: runtimeApi.settings,
    retry: false,
    staleTime: 30_000,
  });
  // 全局那一层装的是当前配置档：预设 + 用户在这个档里的修改
  // （`keymap-profiles.ts`）。换档之后下一帧就生效，因为这份查询变了。
  const global = useMemo(
    () => activeGlobalLayer(settings.data?.keymap),
    [settings.data],
  );
  const device = useDeviceKeymapStore((state) => state.keymap);
  const keymap = useMemo(() => resolveKeymap(global, device), [global, device]);
  // 命令面板、Dock 与右键菜单同步读键位；派发与显示必须是同一份。
  setActiveKeymap(keymap);

  // 旧格式（两个平台共用一条写法）迁移到分平台存储，一次。写入的是同样的
  // 键位，所以迁移前后这台机器上按下去的效果完全一样；失败就下次再说——
  // 读取路径本来就认旧格式，不能因为一次 PATCH 失败让快捷键停摆。
  const migrated = useRef(false);
  const raw = settings.data?.keymap;
  useEffect(() => {
    if (migrated.current || raw === undefined) return;
    const patch = keymapMigrationPatch(raw);
    if (!patch) {
      migrated.current = true;
      return;
    }
    migrated.current = true;
    void runtimeApi
      .updateSettings({ keymap: patch })
      .then((next) => client.setQueryData(["settings"], next))
      .catch(() => {
        migrated.current = false;
      });
  }, [raw, client]);

  const handlers = useMemo<KeybindingHandlers>(() => {
    const map: KeybindingHandlers = {};
    for (const command of COMMANDS) {
      // The browser node's own commands are answered by the node that has the
      // focus (`WebviewSurface` binds them on its subtree). Registering them
      // here too meant this capture-phase listener won first, called a
      // dispatcher that knows nothing of them, and swallowed the keystroke.
      if (command.scope === "browser") continue;
      map[command.id] = () => dispatch.run(command.id);
    }
    return map;
  }, [dispatch]);

  useKeybindings(handlers, { keymap });

  // 系统全局热键：键位一变就整表重新注册（壳先全部释放再装，所以不会残留
  // 上一轮的组合键）。浏览器里 `apply` 是空操作。
  const applyGlobal = useGlobalShortcuts((store) => store.apply);
  useEffect(() => {
    void applyGlobal(globalBindings(keymap));
  }, [applyGlobal, keymap]);

  // 热键触发时跑的是**同一条**画布命令，不是壳里另写一份：壳不知道什么是
  // 终端节点，让它自己去建就会有两套不一致的实现。
  useEffect(
    () =>
      onGlobalShortcut((id) => {
        const action = GLOBAL_SHORTCUT_ACTIONS[id];
        if (action) dispatch.run(action);
      }),
    [dispatch],
  );
}
