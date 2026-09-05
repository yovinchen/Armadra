import { useImperativeHandle, useLayoutEffect, useRef, type Ref } from "react";
import idleAnimalUrl from "./assets/idle-animal.png";
import logoUrl from "./assets/logo.png";
import walkerSheetUrl from "./assets/walker-sheet.png";
import { INK_PATHS, TRACE_PATH } from "./lettering";
import { splashFrameAt, type SplashFrame } from "./timeline";

/**
 * 开屏动画的画面本体：一整块 1920×1080 的 SVG。
 *
 * 它不自己走时间——父组件按帧调 `renderAt`，这里只把结果写到属性上。
 * 每帧重渲染 React 是白费的：八条字形路径每帧都一模一样，diff 的成本远大于
 * 直接改几个属性，所以这里走 ref + `setAttribute`。
 *
 * 三张位图（走姿精灵图、静止姿势、品牌标识）从设计稿里抽成了独立文件，
 * 由 Vite 当资源处理；把 1.5 MB 的 base64 塞回源码会让入口 chunk 直接翻倍。
 */

export interface SplashStageHandle {
  /** 渲染 `[0, SPLASH_DURATION_MS]` 里的某一刻；越界会被夹住。 */
  renderAt: (milliseconds: number) => void;
}

interface SplashStageProps {
  ref?: Ref<SplashStageHandle>;
  /** 无障碍描述；由父组件按语言传进来。 */
  label: string;
}

export function SplashStage({ ref, label }: SplashStageProps) {
  const signature = useRef<SVGGElement>(null);
  const walker = useRef<SVGGElement>(null);
  const sheet = useRef<SVGImageElement>(null);
  const entrance = useRef<SVGRectElement>(null);
  const walking = useRef<SVGRectElement>(null);
  const resting = useRef<SVGRectElement>(null);
  const idle = useRef<SVGGElement>(null);
  const logo = useRef<SVGGElement>(null);
  const trace = useRef<SVGPathElement>(null);
  const tip = useRef<SVGGElement>(null);
  /** 中心线总长；jsdom 没有 SVG 几何，量不到就退化成「不画笔迹动画」。 */
  const traceLength = useRef(0);

  const apply = (frame: SplashFrame) => {
    signature.current?.setAttribute("transform", frame.signature);
    walker.current?.setAttribute("transform", frame.walker);
    walker.current?.setAttribute("opacity", String(frame.walkerOpacity));
    sheet.current?.setAttribute("x", String(frame.sheetX));
    sheet.current?.setAttribute("y", String(frame.sheetY));
    entrance.current?.setAttribute("x", String(frame.entranceX));
    entrance.current?.setAttribute("width", String(frame.entranceWidth));
    walking.current?.setAttribute("width", String(frame.walkingWidth));
    resting.current?.setAttribute("x", String(frame.restingX));
    resting.current?.setAttribute("width", String(frame.restingWidth));
    idle.current?.setAttribute("opacity", String(frame.idleOpacity));
    logo.current?.setAttribute("opacity", String(frame.logoOpacity));

    const path = trace.current;
    const length = traceLength.current;
    if (path && length > 0) {
      path.style.strokeDashoffset = String(
        length * (1 - frame.writingProgress),
      );
      path.style.visibility = frame.writingProgress > 0 ? "visible" : "hidden";
    }

    const pen = tip.current;
    if (!pen) return;
    pen.setAttribute("opacity", String(frame.tipOpacity));
    if (
      frame.tipOpacity > 0 &&
      path &&
      length > 0 &&
      typeof path.getPointAtLength === "function"
    ) {
      const point = path.getPointAtLength(length * frame.writingProgress);
      pen.setAttribute("transform", `translate(${point.x} ${point.y})`);
    }
  };

  // 量长度并落第一帧都必须在浏览器绘制之前完成，否则会闪一下写完的字。
  useLayoutEffect(() => {
    const path = trace.current;
    if (path && typeof path.getTotalLength === "function") {
      const length = path.getTotalLength();
      traceLength.current = length;
      path.style.strokeDasharray = `${length} ${length}`;
    }
    // 只在挂载时跑一次：之后的每一帧都由父组件通过 `renderAt` 推进来。
    apply(splashFrameAt(0));
  }, []);

  useImperativeHandle(ref, () => ({
    renderAt: (milliseconds: number) => apply(splashFrameAt(milliseconds)),
  }));

  return (
    <svg
      viewBox="0 0 1920 1080"
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-label={label}
    >
      <defs>
        <filter
          id="splash-soft-edge"
          x="-10%"
          y="-10%"
          width="120%"
          height="120%"
        >
          <feGaussianBlur stdDeviation="3" />
        </filter>
        {/* 入场遮罩：一块自左向右收回的窗口，先露鼻子再露壳和尾巴。 */}
        <mask
          id="splash-entrance-clip"
          maskUnits="userSpaceOnUse"
          x="600"
          y="140"
          width="700"
          height="420"
          style={{ maskType: "alpha" }}
        >
          <rect
            ref={entrance}
            fill="white"
            filter="url(#splash-soft-edge)"
            x="1080"
            y="170"
            width="100"
            height="340"
          />
        </mask>
        {/* 走姿与静止姿势各占一半，接缝一次扫过去，不做半透明叠化。 */}
        <mask
          id="splash-walking-clip"
          maskUnits="userSpaceOnUse"
          x="600"
          y="140"
          width="700"
          height="420"
          style={{ maskType: "alpha" }}
        >
          <rect
            ref={walking}
            fill="white"
            filter="url(#splash-soft-edge)"
            x="700"
            y="170"
            width="480"
            height="340"
          />
        </mask>
        <mask
          id="splash-resting-clip"
          maskUnits="userSpaceOnUse"
          x="600"
          y="140"
          width="700"
          height="420"
          style={{ maskType: "alpha" }}
        >
          <rect
            ref={resting}
            fill="white"
            filter="url(#splash-soft-edge)"
            x="1180"
            y="170"
            width="0"
            height="340"
          />
        </mask>
        <filter
          id="splash-blue"
          x="-200%"
          y="-200%"
          width="500%"
          height="500%"
          colorInterpolationFilters="sRGB"
        >
          <feGaussianBlur stdDeviation="7" />
        </filter>
        <filter
          id="splash-cyan"
          x="-200%"
          y="-200%"
          width="500%"
          height="500%"
          colorInterpolationFilters="sRGB"
        >
          <feGaussianBlur stdDeviation="2" />
        </filter>
      </defs>

      <rect className="splash-stage-bg" width="1920" height="1080" />

      <g mask="url(#splash-entrance-clip)">
        <g mask="url(#splash-walking-clip)">
          <g
            id="splash-walker"
            ref={walker}
            className="splash-walker"
            opacity="0"
            pointerEvents="none"
          >
            <svg
              x="-224"
              y="-134.4"
              width="368.64"
              height="245.76"
              viewBox="0 0 768 512"
              overflow="hidden"
            >
              <image
                ref={sheet}
                x="0"
                y="0"
                width="1536"
                height="1024"
                href={walkerSheetUrl}
              />
            </svg>
          </g>
        </g>
      </g>

      <g mask="url(#splash-resting-clip)">
        <g
          id="splash-idle"
          ref={idle}
          opacity="0"
          pointerEvents="none"
          transform="translate(960 345)"
        >
          <image
            x="-160"
            y="-160"
            width="320"
            height="320"
            href={idleAnimalUrl}
          />
        </g>
      </g>

      <g id="splash-logo" ref={logo} opacity="0" transform="translate(960 345)">
        <image x="-160" y="-160" width="320" height="320" href={logoUrl} />
      </g>

      <g id="splash-signature" ref={signature}>
        <defs>
          {/* 一条连续的中心线加粗成 72px，就是揭开字形的那把刷子。 */}
          <mask
            id="splash-writing-mask"
            maskUnits="userSpaceOnUse"
            x="300"
            y="340"
            width="1260"
            height="380"
          >
            <g
              fill="none"
              stroke="white"
              strokeWidth="72"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path ref={trace} d={TRACE_PATH} />
            </g>
          </mask>
        </defs>
        <g className="splash-ink" mask="url(#splash-writing-mask)">
          {INK_PATHS.map((d, index) => (
            <path key={index} d={d} />
          ))}
        </g>
        <g ref={tip} opacity="0" pointerEvents="none">
          <circle
            className="splash-tip-halo"
            r="10"
            filter="url(#splash-blue)"
          />
          <circle
            className="splash-tip-light"
            r="4"
            filter="url(#splash-cyan)"
          />
          <circle className="splash-tip-core" r="2.6" />
        </g>
      </g>
    </svg>
  );
}
