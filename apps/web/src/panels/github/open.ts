import { create } from "zustand";

import { useCanvasStore } from "@/store/canvas-store";

/**
 * What the GitHub page is looking at. Kept out of the board document: it is a
 * view preference, not something to undo or save.
 *
 * Selecting an Issue and asking to *see* it are separate intents, so `reveal`
 * is a counter — a card asking for the same Issue twice still navigates.
 */
export type GithubTab = "issues" | "pulls";

export const useGithubFocus = create<{
  tab: GithubTab;
  number: bigint | null;
  reveal: number;
  focus: (tab: GithubTab, number: bigint | null) => void;
  show: (tab: GithubTab, number: bigint) => void;
}>((set) => ({
  tab: "issues",
  number: null,
  focus: (tab, number) => set({ tab, number }),
  reveal: 0,
  show: (tab, number) =>
    set((state) => ({ tab, number, reveal: state.reveal + 1 })),
}));

/** Opens the GitHub page, on one Issue or pull request when given a number. */
export function openGithubPanel(
  tab: GithubTab = "issues",
  number: bigint | null = null,
): void {
  const focus = useGithubFocus.getState();
  if (number !== null) focus.show(tab, number);
  else focus.focus(tab, null);
  useCanvasStore.getState().setPanel("github", "drawer");
}
