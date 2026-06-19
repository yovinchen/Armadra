import { FolderTree, PanelsTopLeft, SlidersHorizontal } from "lucide-react";
import { useCanvasStore } from "../store/canvas-store";
import { usePreferences } from "../preferences/Preferences";

export function MobileNav() {
  const { t } = usePreferences();
  const panel = useCanvasStore((state) => state.mobilePanel);
  const setPanel = useCanvasStore((state) => state.setMobilePanel);
  return (
    <nav className="mobile-nav" aria-label={t("nav.label")}>
      <button
        className={panel === "resources" ? "is-active" : ""}
        aria-pressed={panel === "resources"}
        onClick={() => setPanel("resources")}
      >
        <FolderTree />
        {t("nav.resources")}
      </button>
      <button
        className={panel === "canvas" ? "is-active" : ""}
        aria-pressed={panel === "canvas"}
        onClick={() => setPanel("canvas")}
      >
        <PanelsTopLeft />
        {t("nav.canvas")}
      </button>
      <button
        className={panel === "inspector" ? "is-active" : ""}
        aria-pressed={panel === "inspector"}
        onClick={() => setPanel("inspector")}
      >
        <SlidersHorizontal />
        {t("nav.inspector")}
      </button>
    </nav>
  );
}
