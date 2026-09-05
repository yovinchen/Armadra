import { create } from "zustand";

import { useCanvasStore } from "@/store/canvas-store";

/**
 * Which plan the automation page should scroll to when it opens. Kept out of
 * the board document: it is a view preference, not something to undo or save.
 */
export const useAutomationFocus = create<{
  planId: string | null;
  focus: (planId: string | null) => void;
}>((set) => ({
  planId: null,
  focus: (planId) => set({ planId }),
}));

/** Opens the automation page, optionally on one plan's run history. */
export function openAutomationPanel(planId: string | null = null): void {
  useAutomationFocus.getState().focus(planId);
  useCanvasStore.getState().setPanel("automation", "drawer");
}
