import { useCanvasStore } from "@/store/canvas-store";
import { nodeBox } from "@/canvas/geometry";
import { GithubReferenceBadge } from "./GithubReferenceBadge";

/**
 * GitHub 关联徽标在分组（tldraw 原生 frame）上的位置。
 *
 * frame 没有节点体，也就没有 `headerChips` 槽，所以徽标挂在派生层上，
 * 贴着 frame 左上角的标签行。这一层的坐标就是页面坐标（相机已经变换过），
 * 没有关联时整个组件不画任何像素。
 */
const BADGE_OFFSET = 26;

export function FrameReferenceBadges() {
  const nodes = useCanvasStore((state) => state.document?.nodes);
  const frames = (nodes ?? []).filter((node) => node.type === "group");
  if (frames.length === 0) return null;
  return (
    <>
      {frames.map((frame) => {
        const box = nodeBox(nodes ?? [], frame);
        return (
          <div
            key={frame.id}
            data-slot="github-frame-references"
            className="absolute flex gap-1"
            style={{
              left: box.x,
              top: box.y - BADGE_OFFSET,
              pointerEvents: "all",
            }}
          >
            <GithubReferenceBadge nodeId={frame.id} />
          </div>
        );
      })}
    </>
  );
}
