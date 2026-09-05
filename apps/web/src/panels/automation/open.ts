import { create } from "zustand";

import { useCanvasStore } from "@/store/canvas-store";
import type { CreatePlanPrefill } from "./CreatePlanForm";

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
  /**
   * What the create form should start from, when something outside the page
   * asked for a plan. Cleared as soon as the form has been shown once: it is a
   * one-shot request, not a mode the page stays in.
   */
  prefill: CreatePlanPrefill | null;
  compose: number;
  focus: (planId: string | null) => void;
  revealRuns: (planId: string) => void;
  proposePlan: (prefill: CreatePlanPrefill) => void;
  clearPrefill: () => void;
}>((set) => ({
  planId: null,
  reveal: 0,
  prefill: null,
  compose: 0,
  focus: (planId) => set({ planId }),
  revealRuns: (planId) =>
    set((state) => ({ planId, reveal: state.reveal + 1 })),
  proposePlan: (prefill) =>
    set((state) => ({ prefill, compose: state.compose + 1 })),
  clearPrefill: () => set({ prefill: null }),
}));

/** Opens the automation page, on one plan's run history when given a plan. */
export function openAutomationPanel(planId: string | null = null): void {
  const focus = useAutomationFocus.getState();
  if (planId) focus.revealRuns(planId);
  else focus.focus(null);
  useCanvasStore.getState().setPanel("automation", "drawer");
}

/**
 * "Turn into a platform plan" from a native activity card (automation design
 * §3). It opens the create form pre-filled and marked as coming from a native
 * observation — nothing is created, nothing is activated, and the native card
 * stays exactly where it was. The two entities never convert into one another;
 * this is a person deciding to write a second, platform-owned plan.
 */
export function proposePlanFromNative(prefill: CreatePlanPrefill): void {
  useAutomationFocus.getState().proposePlan(prefill);
  useCanvasStore.getState().setPanel("automation", "drawer");
}
