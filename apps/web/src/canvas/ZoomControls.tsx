import { useReactFlow, useStore } from "@xyflow/react";
import { usePreferences } from "../preferences/Preferences";

/** Zoom bounds and step from SPEC §6 / the prototype's zoom column. */
export const MIN_ZOOM = 0.25;
export const MAX_ZOOM = 2;
export const ZOOM_STEP = 1.2;
export const FIT_VIEW_OPTIONS = { padding: 0.1, maxZoom: 1.5 } as const;

/** Bottom-left 32px column: ＋ / percentage / − / ⛶ (replaces `<Controls>`). */
export function ZoomControls() {
  const { t } = usePreferences();
  const { zoomTo, getZoom, fitView } = useReactFlow();
  const zoom = useStore((state) => state.transform[2]);

  // `getZoom()` rather than the rendered value: two quick clicks must compound
  // instead of both starting from the same painted zoom.
  const by = (factor: number) =>
    void zoomTo(Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, getZoom() * factor)));

  return (
    <div
      className="canvas-zoom"
      role="group"
      aria-label={t("canvas.zoom.group")}
    >
      <button
        type="button"
        className="canvas-zoom-step"
        title={t("canvas.zoom.in")}
        aria-label={t("canvas.zoom.in")}
        onClick={() => by(ZOOM_STEP)}
      >
        +
      </button>
      <button
        type="button"
        className="canvas-zoom-value"
        title={t("canvas.zoom.reset")}
        onClick={() => void zoomTo(1)}
      >
        {Math.round(zoom * 100)}%
      </button>
      <button
        type="button"
        className="canvas-zoom-step"
        title={t("canvas.zoom.out")}
        aria-label={t("canvas.zoom.out")}
        onClick={() => by(1 / ZOOM_STEP)}
      >
        −
      </button>
      <button
        type="button"
        className="canvas-zoom-fit"
        title={t("canvas.zoom.fit")}
        aria-label={t("canvas.zoom.fit")}
        onClick={() => void fitView(FIT_VIEW_OPTIONS)}
      >
        ⛶
      </button>
    </div>
  );
}
