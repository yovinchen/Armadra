import { usePreferences } from "../preferences/Preferences";
import { EMPTY_IMAGE_SRC } from "./defaults";
import type { NodeContentProps, OfKind } from "./types";

/** Image body: the inlined data URL, or the source path when none was read. */
export function ImageNode({ data }: NodeContentProps) {
  const { t } = usePreferences();
  const image = data as OfKind<"image">;
  const hasImage = Boolean(image.src) && image.src !== EMPTY_IMAGE_SRC;

  if (!hasImage) {
    return (
      <div className="image-body image-body--empty nodrag">
        {image.sourcePath ? (
          <>
            <code className="image-path">{image.sourcePath}</code>
            <p className="image-hint">{t("image.pathOnly")}</p>
          </>
        ) : (
          <p className="image-hint">{t("image.empty")}</p>
        )}
      </div>
    );
  }

  return (
    <div className="image-body nodrag">
      <img className="image-preview" src={image.src} alt={image.title} />
    </div>
  );
}
