import { create } from "zustand";

import type { CommandId } from "../../keybindings";
import {
  emptyKeymap,
  loadDeviceKeymap,
  saveDeviceKeymap,
  type PlatformName,
  type StoredKeymap,
} from "./keymap";

/**
 * 「本设备」那一层（终端宿主设计 §10：平台默认 → 用户同步配置 → 设备覆盖）。
 *
 * 存 localStorage、按设备 id 分格，**不上行**：一台机器上换的键位不该跟着账号
 * 跑到另一台机器。全局快捷键 hook 与设置页读同一个 store，所以在设置页改完
 * 下一帧就生效，不需要刷新。
 */
export interface DeviceKeymapStore {
  keymap: StoredKeymap;
  /** 写入当前平台那一格；另一个平台保持原样。 */
  setChord: (platform: PlatformName, id: CommandId, chord: string) => void;
  /** 删掉本设备这一条，落回全局或默认。 */
  clearChord: (platform: PlatformName, id: CommandId) => void;
  replace: (next: StoredKeymap) => void;
  clearAll: () => void;
}

function persist(keymap: StoredKeymap): StoredKeymap {
  saveDeviceKeymap(keymap);
  return keymap;
}

export const useDeviceKeymapStore = create<DeviceKeymapStore>((set) => ({
  keymap: loadDeviceKeymap(),
  setChord: (platform, id, chord) =>
    set((state) =>
      // 每次都换出新的对象，`resolveKeymap` 的 memo 才知道要重算。
      ({
        keymap: persist({
          ...state.keymap,
          [platform]: { ...state.keymap[platform], [id]: chord },
        }),
      }),
    ),
  clearChord: (platform, id) =>
    set((state) => {
      const next = { ...state.keymap[platform] };
      delete next[id];
      return { keymap: persist({ ...state.keymap, [platform]: next }) };
    }),
  replace: (next) => set({ keymap: persist(next) }),
  clearAll: () => set({ keymap: persist(emptyKeymap()) }),
}));
