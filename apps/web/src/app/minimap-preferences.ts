import { create } from "zustand";

const STORAGE_KEY = "armadra.minimapCollapsed";
function readCollapsed(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

/** Shared by the minimap and shell so the usage orb follows the collapsed edge. */
export const useMinimapPreferences = create<{
  collapsed: boolean;
  setCollapsed: (collapsed: boolean) => void;
}>((set) => ({
  collapsed: readCollapsed(),
  setCollapsed: (collapsed) => {
    set({ collapsed });
    try {
      localStorage.setItem(STORAGE_KEY, String(collapsed));
    } catch {
      /* Optional persistence. */
    }
  },
}));
