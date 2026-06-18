import { useEffect, useRef, type ReactNode } from "react";
import { motion } from "motion/react";
import { useCanvasStore } from "../store/canvas-store";

/**
 * Overlay chrome shared by the four v2 overlays (SPEC §10).
 *
 * - `center` — 新建工作空间 / 设置
 * - `top`    — ⌘K 命令面板（距顶 140px）
 * - `drawer` — Diff 扫描抽屉（右侧浮层，遮罩透明）
 *
 * Esc is intentionally *not* handled here: `canvas/shortcuts.ts` owns the
 * global Escape binding and already calls `setModal(null)` (plan §1.4).
 */
export type ModalVariant = "center" | "top" | "drawer";

const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

export function ModalShell({
  variant = "center",
  className,
  labelledBy,
  label,
  children,
}: {
  variant?: ModalVariant;
  className?: string;
  /** id of the heading inside the panel. */
  labelledBy?: string;
  /** Fallback accessible name when the panel has no visible heading. */
  label?: string;
  children: ReactNode;
}) {
  const setModal = useCanvasStore((state) => state.setModal);
  const panelRef = useRef<HTMLElement | null>(null);

  // Focus enters the dialog on open and returns to the trigger on close.
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    const first = panel?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? panel)?.focus({ preventScroll: true });
    return () => previous?.focus?.({ preventScroll: true });
  }, []);

  const trapTab = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Tab") return;
    const panel = panelRef.current;
    if (!panel) return;
    const items = Array.from(
      panel.querySelectorAll<HTMLElement>(FOCUSABLE),
    ).filter((item) => item.offsetParent !== null || item === panel);
    if (items.length === 0) {
      event.preventDefault();
      panel.focus();
      return;
    }
    const first = items[0]!;
    const last = items[items.length - 1]!;
    const active = document.activeElement as HTMLElement | null;
    if (event.shiftKey && (active === first || active === panel)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <motion.div
      className={`modal-backdrop modal-backdrop--${variant}`}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) setModal(null);
      }}
    >
      <motion.section
        ref={panelRef as never}
        tabIndex={-1}
        className={`modal-panel modal-panel--${variant}${className ? ` ${className}` : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        aria-label={labelledBy ? undefined : label}
        initial={{ opacity: 0, ...enterFrom(variant) }}
        animate={{ opacity: 1, x: 0, y: 0, scale: 1 }}
        onKeyDown={trapTab}
      >
        {children}
      </motion.section>
    </motion.div>
  );
}

/** Motion is limited to opacity/transform and ≤160 ms (plan §0). */
function enterFrom(variant: ModalVariant): {
  x?: number;
  y?: number;
  scale?: number;
} {
  if (variant === "drawer") return { x: 12, y: 0, scale: 1 };
  if (variant === "top") return { x: 0, y: -8, scale: 1 };
  return { x: 0, y: 6, scale: 0.985 };
}
