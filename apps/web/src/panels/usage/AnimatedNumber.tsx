import { useEffect, useRef, useState } from "react";
import { animate, useMotionValue, useReducedMotion } from "motion/react";

import { cn } from "@/lib/cn";

/**
 * 数字之间补间。指标切换时卡片与元数据不硬跳，跟着图表一起走。
 * 首次挂载直接显示目标值——入场已经有淡入了，数字再从 0 爬一遍是噪音。
 */
export function AnimatedNumber({
  value,
  format,
  className,
}: {
  value: number;
  format: (value: number) => string;
  className?: string;
}) {
  const reduced = useReducedMotion();
  const motionValue = useMotionValue(value);
  const [display, setDisplay] = useState(value);
  const mounted = useRef(false);

  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    if (reduced) {
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
  }, [motionValue, reduced, value]);

  return (
    <span className={cn("tabular-nums", className)}>{format(display)}</span>
  );
}
