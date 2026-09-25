import { create } from "zustand";

import type { CommandId } from "../../keybindings";
import {
  emptyKeymap,
  loadDeviceKeymap,
  saveDeviceKeymap,
  type KeymapSection,
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
  /**
   * 写入一格：当前平台的键位，或不分平台的 `when`；其余格保持原样。
   * 空串也是一条覆盖（清空 / 不设条件），要删回下一层用 `clearChord`。
   */
  setChord: (section: KeymapSection, id: CommandId, value: string) => void;
  /** 删掉本设备这一条，落回全局或默认。 */
  clearChord: (section: KeymapSection, id: CommandId) => void;
  replace: (next: StoredKeymap) => void;
  clearAll: () => void;
}

function persist(keymap: StoredKeymap): StoredKeymap {
  saveDeviceKeymap(keymap);
  return keymap;
}

export const useDeviceKeymapStore = create<DeviceKeymapStore>((set) => ({
  keymap: loadDeviceKeymap(),
  setChord: (section, id, value) =>
    set((state) =>
      // 每次都换出新的对象，`resolveKeymap` 的 memo 才知道要重算。
      ({
        keymap: persist({
          ...state.keymap,
          [section]: { ...state.keymap[section], [id]: value },
        }),
      }),
    ),
  clearChord: (section, id) =>
    set((state) => {
      const next = { ...state.keymap[section] };
      delete next[id];
      return { keymap: persist({ ...state.keymap, [section]: next }) };
    }),
  replace: (next) => set({ keymap: persist(next) }),
  clearAll: () => set({ keymap: persist(emptyKeymap()) }),
}));
