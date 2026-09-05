import { create } from "zustand";

import { useCanvasStore } from "@/store/canvas-store";

/**
 * Which plan the automation page is looking at. Kept out of the board document:
 * it is a view preference, not something to undo or save.
 *
 * Selecting a plan and asking to *see* its runs are separate, because they are
 * separate intents: creating a plan selects it but must leave the reader on the
 * plan list, while a card's "view run history" has to navigate even when the
 * page is already open. `reveal` is a counter so a repeat request still moves.
 */
export const useAutomationFocus = create<{
  planId: string | null;
  reveal: number;
  focus: (planId: string | null) => void;
  revealRuns: (planId: string) => void;
}>((set) => ({
  planId: null,
  reveal: 0,
  focus: (planId) => set({ planId }),
  revealRuns: (planId) =>
    set((state) => ({ planId, reveal: state.reveal + 1 })),
}));

/** Opens the automation page, on one plan's run history when given a plan. */
export function openAutomationPanel(planId: string | null = null): void {
  const focus = useAutomationFocus.getState();
  if (planId) focus.revealRuns(planId);
  else focus.focus(null);
  useCanvasStore.getState().setPanel("automation", "drawer");
}
