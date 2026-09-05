/**
 * 「这个节点现在看得见吗」——采样节奏的依据（路线图 §4.3）。
 *
 * 三件事都算看不见，因为三件事都意味着没人在看这个数字：
 *
 *  1. 节点折叠或已退出（调用方给的 `mounted`）；
 *  2. 元素滚出了视口——画布不裁剪节点（`canCull() => false`，见
 *     `ArmadraShapeUtil`），所以离屏的节点仍然挂在 DOM 上，只有
 *     `IntersectionObserver` 能说出它其实在屏幕外；
 *  3. 整个窗口切到后台。
 *
 * 拿不到 `IntersectionObserver` 的环境（jsdom、很旧的浏览器）按**看得见**
 * 处理：宁可多采几次，也不要让一个用户正盯着的徽标停在 30 秒前的数字上。
 */
import { useEffect, useState, type RefObject } from "react";

export function useOnScreen(ref: RefObject<Element | null>): boolean {
  const [onScreen, setOnScreen] = useState(true);
  useEffect(() => {
    const element = ref.current;
    if (!element || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        const last = entries.at(-1);
        if (last) setOnScreen(last.isIntersecting);
      },
      // 一点点露出来就算看得见：半个终端头部也是在看。
      { threshold: 0 },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return onScreen;
}

export function usePageVisible(): boolean {
  const [visible, setVisible] = useState(
    () => typeof document === "undefined" || !document.hidden,
  );
  useEffect(() => {
    if (typeof document === "undefined") return;
    const update = () => setVisible(!document.hidden);
    update();
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
  return visible;
}
