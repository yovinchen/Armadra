import { useEffect, useRef, useState } from "react";
import { animate, useMotionValue, useReducedMotion } from "motion/react";

import { cn } from "@/lib/cn";

/**
 * 数字之间补间。切范围、选中某天时数字跟着图表一起走，不硬跳。
 * 首次挂载直接显示目标值——入场已经有淡入了，数字再从 0 爬一遍是噪音。
 * `unit` 变了也直接跳：从几百亿 token 补间到几千美元没有意义，而补间起步前
 * 那几帧会把旧的 token 数按美元格式显示出来。
 */
export function AnimatedNumber({
  value,
  format,
  unit,
  className,
}: {
  value: number;
  format: (value: number) => string;
  unit?: string;
  className?: string;
}) {
  const reduced = useReducedMotion();
  const motionValue = useMotionValue(value);
  const [display, setDisplay] = useState(value);
  const mounted = useRef(false);
  const lastUnit = useRef(unit);

  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    const unitChanged = lastUnit.current !== unit;
    lastUnit.current = unit;
    if (reduced || unitChanged) {
      motionValue.set(value);
      setDisplay(value);
      return;
    }
    const controls = animate(motionValue, value, {
      duration: 0.35,
      ease: "easeOut",
      onUpdate: (latest) => setDisplay(latest),
    });
    return () => controls.stop();
  }, [motionValue, reduced, unit, value]);

  // 换单位的那一次渲染先于 effect：这一帧就得按新值显示，否则旧数字会穿上新格式。
  const shown = lastUnit.current !== unit ? value : display;
  return <span className={cn("tabular-nums", className)}>{format(shown)}</span>;
}
