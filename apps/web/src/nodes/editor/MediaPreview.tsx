import * as React from "react";

import { useT } from "@/app/preferences-store";
import { Badge } from "@/ui/badge";
import { ToggleGroup, ToggleGroupItem } from "@/ui/toggle-group";
import type { MediaKind } from "./types";

/**
 * 非文本文件的预览：图片、音视频、PDF。
 *
 * 字节都是经 `file-download` 取回、在页面里按 Runtime 报的 MIME 包成 blob
 * 的——那条路由为了不让上传的 HTML 在 core 的来源里执行，永远回答
 * `application/octet-stream` 附件，不能直接当 `src`。播放和翻页都交给引擎
 * 自带的控件，这里不重画一套。
 */
export function MediaPreview({
  media,
  src,
  title,
  onError,
}: {
  media: MediaKind;
  src: string;
  title: string;
  /** 引擎解不开：退回下载卡片。 */
  onError: () => void;
}) {
  if (media === "image")
    return <ImagePreview src={src} title={title} onError={onError} />;
  if (media === "video")
    return (
      <div className="flex h-full w-full items-center justify-center bg-[var(--surface-sunken)]">
        <video
          src={src}
          controls
          preload="metadata"
          onError={onError}
          className="max-h-full max-w-full"
        />
      </div>
    );
  if (media === "audio")
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-3 p-4">
        <p className="max-w-full truncate text-sm">{title}</p>
        <audio
          src={src}
          controls
          preload="metadata"
          onError={onError}
          className="w-full max-w-md"
        />
      </div>
    );
  return (
    <iframe
      src={src}
      title={title}
      // 不加 sandbox：带沙箱的框架里引擎直接拒绝启动 PDF 查看器。blob 是
      // 页面按 `application/pdf` 自己包的，引擎把它交给查看器而不是当 HTML
      // 解析，所以这里没有可执行的页面内容。
      className="h-full w-full border-0 bg-[var(--surface-sunken)]"
    />
  );
}

/** 滚轮一格的缩放倍数；上下限防止缩成一个点或放大到卡住布局。 */
const WHEEL_STEP = 1.1;
const MIN_SCALE = 0.05;
const MAX_SCALE = 32;

type Zoom = { mode: "fit" } | { mode: "scale"; scale: number };

/**
 * 图片：适应 / 1:1 / 滚轮缩放，透明区域画棋盘格。
 *
 * 滚轮直接缩放而不是滚动：节点体已经是 `nowheel`，画布不会跟着缩；放大
 * 以后超出的部分靠滚动条看。从「适应」开始滚时，以当前实际显示的比例为
 * 起点，而不是从 100% 突然跳一下。
 */
function ImagePreview({
  src,
  title,
  onError,
}: {
  src: string;
  title: string;
  onError: () => void;
}) {
  const t = useT();
  const [zoom, setZoom] = React.useState<Zoom>({ mode: "fit" });
  const [natural, setNatural] = React.useState<{
    width: number;
    height: number;
  } | null>(null);
  const imageRef = React.useRef<HTMLImageElement | null>(null);

  /** 「适应」时图片实际被缩到了多少，给百分比徽标与滚轮起点用。 */
  const displayedScale = (): number => {
    if (zoom.mode === "scale") return zoom.scale;
    const image = imageRef.current;
    if (!image || !natural || natural.width === 0) return 1;
    return image.clientWidth / natural.width;
  };

  const onWheel = (event: React.WheelEvent) => {
    if (event.deltaY === 0) return;
    const factor = event.deltaY < 0 ? WHEEL_STEP : 1 / WHEEL_STEP;
    const next = Math.min(
      MAX_SCALE,
      Math.max(MIN_SCALE, displayedScale() * factor),
    );
    setZoom({ mode: "scale", scale: next });
  };

  const scaled =
    zoom.mode === "scale" && natural
      ? {
          width: Math.round(natural.width * zoom.scale),
          height: Math.round(natural.height * zoom.scale),
        }
      : null;

  return (
    <div className="relative h-full w-full">
      <div
        data-testid="image-viewport"
        onWheel={onWheel}
        className="h-full w-full overflow-auto"
      >
        <div
          className={
            scaled
              ? "flex min-h-full min-w-full w-max items-center justify-center p-2"
              : "flex h-full w-full items-center justify-center p-2"
          }
        >
          <img
            ref={imageRef}
            src={src}
            alt={title}
            draggable={false}
            onLoad={(event) =>
              setNatural({
                width: event.currentTarget.naturalWidth,
                height: event.currentTarget.naturalHeight,
              })
            }
            onError={onError}
            style={{
              ...(scaled
                ? {
                    width: scaled.width,
                    height: scaled.height,
                    maxWidth: "none",
                  }
                : {}),
              // 透明区域的棋盘格：两种表面色交替，深浅主题都跟着 token 走。
              backgroundImage:
                "repeating-conic-gradient(var(--surface-deep) 0 25%, var(--surface-raised) 0 50%)",
              backgroundSize: "16px 16px",
              imageRendering:
                zoom.mode === "scale" && zoom.scale >= 4
                  ? "pixelated"
                  : undefined,
            }}
            className={
              scaled ? "shrink-0" : "max-h-full max-w-full object-contain"
            }
          />
        </div>
      </div>
      <div className="absolute bottom-2 right-2 flex items-center gap-1.5 rounded-[var(--radius-sm)] bg-[var(--surface-deep)]/90 p-1">
        <Badge variant="outline" className="tabular-nums">
          {Math.round(displayedScale() * 100)}%
        </Badge>
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          value={zoom.mode === "fit" ? "fit" : zoom.scale === 1 ? "actual" : ""}
          onValueChange={(next) => {
            if (next === "fit") setZoom({ mode: "fit" });
            else if (next === "actual") setZoom({ mode: "scale", scale: 1 });
          }}
          aria-label={t("editor.image.zoom")}
        >
          <ToggleGroupItem value="fit">{t("editor.image.fit")}</ToggleGroupItem>
          <ToggleGroupItem value="actual">
            {t("editor.image.actual")}
          </ToggleGroupItem>
        </ToggleGroup>
      </div>
    </div>
  );
}
