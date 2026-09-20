import { useEffect, useRef, useState } from "react";
import { animate, useReducedMotion } from "motion/react";

import { formatMetric, type UsageMetric } from "./metrics";

export type DonutSlice = {
  key: string;
  label: string;
  value: number;
  color: string;
};

const SIZE = 104;
const OUTER = 50;
const INNER = 32;
const GAP = 1;
const CENTER = SIZE / 2;

type Arc = {
  key: string;
  label: string;
  color: string;
  from: number;
  to: number;
};

type Span = { from: number; to: number };

type Pair = { head: Arc; start: Span; end: Span };

/**
 * 自绘环形图。
 *
 * recharts 3.10 的 `Pie` 在切换指标时会有约 300ms 只画出旧的扇区数——不重挂载
 * 也一样，所以这里直接补间起止角：片数变了也只是从零角展开或收缩到零。
 */
export function Donut({
  slices,
  metric,
}: {
  slices: DonutSlice[];
  metric: UsageMetric;
}) {
  const reduced = useReducedMotion();
  const [arcs, setArcs] = useState<Arc[]>(() => layout(slices));
  const current = useRef<Arc[]>(arcs);

  useEffect(() => {
    const target = layout(slices);
    const from = current.current;
    const pairs = merge(from, target);
    if (reduced) {
      current.current = target;
      setArcs(target);
      return;
    }
    const controls = animate(0, 1, {
      duration: 0.35,
      ease: "easeOut",
      onUpdate: (progress) => {
        const next = pairs.map(({ head, start, end }) => ({
          ...head,
          from: start.from + (end.from - start.from) * progress,
          to: start.to + (end.to - start.to) * progress,
        }));
        current.current = next;
        setArcs(next);
      },
      onComplete: () => {
        current.current = target;
        setArcs(target);
      },
    });
    return () => controls.stop();
  }, [reduced, slices]);

  const values = new Map(slices.map((slice) => [slice.key, slice.value]));

  return (
    <div data-slot="usage-donut" className="size-[104px]">
      <svg viewBox={`0 0 ${SIZE} ${SIZE}`} className="size-full">
        {arcs.length === 0 && (
          <circle
            data-slot="usage-donut-track"
            cx={CENTER}
            cy={CENTER}
            r={(OUTER + INNER) / 2}
            fill="none"
            stroke="var(--muted)"
            strokeWidth={OUTER - INNER}
          />
        )}
        {arcs.map((arc) => (
          <path
            key={arc.key}
            data-slot="usage-donut-slice"
            data-key={arc.key}
            d={ring(arc.from, arc.to)}
            fill={arc.color}
          >
            <title>{`${arc.label} · ${formatMetric(values.get(arc.key) ?? 0, metric)}`}</title>
          </path>
        ))}
      </svg>
    </div>
  );
}

/** 把切片折成起止角（12 点起顺时针），片与片之间留 `GAP` 度。 */
function layout(slices: DonutSlice[]): Arc[] {
  const usable = slices.filter((slice) => slice.value > 0);
  const total = usable.reduce((sum, slice) => sum + slice.value, 0);
  if (total <= 0) return [];
  const gap = usable.length > 1 ? GAP : 0;
  let cursor = 0;
  return usable.map((slice) => {
    const sweep = (slice.value / total) * 360;
    const from = cursor + gap / 2;
    cursor += sweep;
    return {
      key: slice.key,
      label: slice.label,
      color: slice.color,
      from,
      to: Math.max(from, cursor - gap / 2),
    };
  });
}

/**
 * 起止两套几何按 key 对齐：新片从目标起点的零角展开，消失的片收缩回零角，
 * 两边都在场时按顺序插在一起，补间中不会有片突然跳位。
 */
function merge(from: Arc[], to: Arc[]): Pair[] {
  const before = new Map(from.map((arc) => [arc.key, arc]));
  const after = new Map(to.map((arc) => [arc.key, arc]));
  const pairs: Pair[] = to.map((arc) => {
    const seen = before.get(arc.key);
    return {
      head: arc,
      start: seen ?? { from: arc.from, to: arc.from },
      end: arc,
    };
  });
  for (const arc of from) {
    if (after.has(arc.key)) continue;
    pairs.push({
      head: arc,
      start: arc,
      end: { from: arc.from, to: arc.from },
    });
  }
  return pairs;
}

function point(radius: number, angle: number): [number, number] {
  const rad = ((angle - 90) * Math.PI) / 180;
  return [CENTER + radius * Math.cos(rad), CENTER + radius * Math.sin(rad)];
}

function ring(from: number, to: number): string {
  const sweep = Math.min(to - from, 359.99);
  if (sweep <= 0.01) return "";
  const end = from + sweep;
  const large = sweep > 180 ? 1 : 0;
  const [x0, y0] = point(OUTER, from);
  const [x1, y1] = point(OUTER, end);
  const [x2, y2] = point(INNER, end);
  const [x3, y3] = point(INNER, from);
  return [
    `M${x0} ${y0}`,
    `A${OUTER} ${OUTER} 0 ${large} 1 ${x1} ${y1}`,
    `L${x2} ${y2}`,
    `A${INNER} ${INNER} 0 ${large} 0 ${x3} ${y3}`,
    "Z",
  ].join("");
}
