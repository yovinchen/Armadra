import { useEffect, useRef } from "react";
import { motion } from "motion/react";
import type { CanvasEdgeType } from "@ai-coding-canvas/shared";
import { EDGE_META } from "../nodes";
import { usePreferences } from "../preferences/Preferences";

export const PICKER_WIDTH = 280;
/** Roughly the popover height; used to clamp it inside the stage. */
export const PICKER_HEIGHT = 360;

export interface EdgePickerProps {
  fromTitle: string;
  toTitle: string;
  /** Recommended semantic first — the `1` key always picks it. */
  types: CanvasEdgeType[];
  /** Drop point in stage coordinates; already clamped by the caller. */
  x: number;
  y: number;
  onPick: (type: CanvasEdgeType) => void;
  onCancel: () => void;
}

/** Connection semantics popover (SPEC §4): 1–6 quick pick, Esc cancels. */
export function EdgePicker({
  fromTitle,
  toTitle,
  types,
  x,
  y,
  onPick,
  onCancel,
}: EdgePickerProps) {
  const { t } = usePreferences();
  const root = useRef<HTMLDivElement>(null);
  const pick = useRef(onPick);
  const cancel = useRef(onCancel);
  pick.current = onPick;
  cancel.current = onCancel;
  const options = useRef(types);
  options.current = types;

  useEffect(() => {
    root.current?.querySelector<HTMLButtonElement>("button")?.focus();
    // Capture + stopImmediatePropagation: while the picker is open it owns Esc
    // and 1–6, whatever `useCanvasShortcuts` would otherwise do with them.
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        cancel.current();
        return;
      }
      const type = options.current[Number.parseInt(event.key, 10) - 1];
      if (type) {
        event.preventDefault();
        event.stopImmediatePropagation();
        pick.current(type);
      }
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null;
      if (!root.current?.contains(target)) cancel.current();
    };
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, []);

  return (
    <motion.div
      ref={root}
      className="edge-picker"
      role="dialog"
      aria-label={t("canvas.edge.title")}
      style={{ left: x, top: y, width: PICKER_WIDTH }}
      initial={{ opacity: 0, scale: 0.98 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.98 }}
    >
      <div className="edge-picker-head">
        <strong>{fromTitle}</strong>
        <span aria-hidden="true">→</span>
        <strong>{toTitle}</strong>
      </div>
      <div className="edge-picker-eyebrow">{t("canvas.edge.title")}</div>
      <div className="edge-picker-list">
        {types.map((type, index) => (
          <button
            key={type}
            type="button"
            className="edge-picker-option"
            onClick={() => onPick(type)}
          >
            <span className="edge-picker-glyph" aria-hidden="true">
              {EDGE_META[type].glyph}
            </span>
            <span className="edge-picker-text">
              <span className="edge-picker-label">
                {t(EDGE_META[type].label)}
              </span>
              <span className="edge-picker-desc">
                {t(`canvas.edge.desc.${type}`)}
              </span>
            </span>
            <span className="edge-picker-key">{index + 1}</span>
          </button>
        ))}
      </div>
    </motion.div>
  );
}
