import { useSyncExternalStore } from "react";

const COMPACT_QUERY = "(max-width: 767px)";
export function isCompactLayout(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia(COMPACT_QUERY).matches
  );
}
function subscribe(callback: () => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function")
    return () => undefined;
  const media = window.matchMedia(COMPACT_QUERY);
  media.addEventListener("change", callback);
  return () => media.removeEventListener("change", callback);
}
export function useCompactLayout(): boolean {
  return useSyncExternalStore(subscribe, isCompactLayout, () => false);
}
