import { useCallback, useEffect, useRef, useState } from "react";
import {
  useResolvedTheme,
  usePreferencesStore,
  useT,
} from "../app/preferences-store";
import { SplashStage, type SplashStageHandle } from "./SplashStage";
import { SPLASH_DURATION_MS, SPLASH_FPS } from "./timeline";
import "./splash.css";

/**
 * 开屏动画的覆盖层。
 *
 * 它只管三件事：主题、推帧、什么时候退场。App 在它下面照常挂载、照常连
 * Runtime——覆盖层不挡数据加载，只挡这几秒的鼠标和键盘。
 */

/** 淡出时长，与 splash.css 里的 transition 保持一致。 */
const FADE_MS = 260;
/** 播满 1 秒才允许跳过：太早的一次误点会让人根本没看见动画。 */
export const SKIP_AFTER_MS = 1000;
/** `prefers-reduced-motion` 下只停终态这么久。 */
export const REDUCED_HOLD_MS = 1000;

function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function")
    return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * 播放期间跟随系统主题。
 *
 * `syncDocumentPreferences` 也装了同一个监听，但那是 App 挂载之后的事；
 * 覆盖层比它先出现，所以自己也得装一个。两边都只是把系统色写回 store，
 * 重复调用无害。
 */
function useSystemThemeWatch(): void {
  const setSystemTheme = usePreferencesStore((state) => state.setSystemTheme);
  useEffect(() => {
    if (
      typeof window === "undefined" ||
      typeof window.matchMedia !== "function"
    ) {
      return;
    }
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => setSystemTheme(media.matches ? "dark" : "light");
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [setSystemTheme]);
}

export interface SplashProps {
  /** 淡出结束后调用；挂载方在这里把整棵覆盖层从 DOM 上摘掉。 */
  onDismiss: () => void;
}

export function Splash({ onDismiss }: SplashProps) {
  const t = useT();
  useSystemThemeWatch();
  // `armadra.theme` 是 system 时跟系统走，明确选了 light / dark 就按用户选的。
  const theme = useResolvedTheme();
  const stage = useRef<SplashStageHandle>(null);
  const [leaving, setLeaving] = useState(false);
  const openedAt = useRef(Date.now());
  const [reduced, setReduced] = useState(prefersReducedMotion);

  const finish = useCallback(() => setLeaving(true), []);

  useEffect(() => {
    if (
      typeof window === "undefined" ||
      typeof window.matchMedia !== "function"
    ) {
      return;
    }
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const apply = () => setReduced(media.matches);
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, []);

  // 推帧。减少动态时直接落终态，停一会儿就走。
  useEffect(() => {
    const api = stage.current;
    if (!api || leaving) return;
    if (reduced) {
      api.renderAt(SPLASH_DURATION_MS);
      const timer = window.setTimeout(finish, REDUCED_HOLD_MS);
      return () => window.clearTimeout(timer);
    }
    // 按 30fps 取整推进：和设计稿的逐帧导出一致，高刷屏上也不会多画。
    //
    // 每一帧同时挂 rAF 和一个定时器，谁先到谁推进、另一个作废。只靠 rAF 不
    // 行：桌面壳的窗口是先隐藏着加载页面、Runtime 就绪后才显示的，WKWebView
    // 在这段时间里不派发 rAF，显示之后也不一定恢复——动画会停在第一帧，
    // 覆盖层把整个 App 压在底下。定时器不受渲染节流影响，兜住这种情况。
    const frameInterval = 1000 / SPLASH_FPS;
    let animation = 0;
    let timer = 0;
    let started: number | null = null;
    let lastFrame = -1;
    const cancel = () => {
      cancelAnimationFrame(animation);
      window.clearTimeout(timer);
    };
    const tick = (now: number) => {
      cancel();
      if (started === null) started = now;
      const elapsed = Math.min(SPLASH_DURATION_MS, now - started);
      const frame = Math.floor((elapsed * SPLASH_FPS) / 1000);
      if (frame !== lastFrame) {
        api.renderAt((frame * 1000) / SPLASH_FPS);
        lastFrame = frame;
      }
      if (elapsed < SPLASH_DURATION_MS) schedule();
      else finish();
    };
    const schedule = () => {
      animation = requestAnimationFrame(tick);
      timer = window.setTimeout(
        () => tick(performance.now()),
        frameInterval * 2,
      );
    };
    api.renderAt(0);
    schedule();
    return cancel;
  }, [reduced, leaving, finish]);

  // 保险丝：不管帧推没推到头，到点就走。覆盖层吃掉所有输入，卡住等于把整个
  // App 锁死，所以它的寿命不能只系在动画循环上。
  useEffect(() => {
    if (leaving) return;
    const timer = window.setTimeout(finish, SPLASH_DURATION_MS + FADE_MS);
    return () => window.clearTimeout(timer);
  }, [leaving, finish]);

  // 淡出结束后才把 DOM 摘掉。
  useEffect(() => {
    if (!leaving) return;
    const timer = window.setTimeout(onDismiss, FADE_MS);
    return () => window.clearTimeout(timer);
  }, [leaving, onDismiss]);

  const skip = useCallback(() => {
    if (Date.now() - openedAt.current < SKIP_AFTER_MS) return;
    finish();
  }, [finish]);

  useEffect(() => {
    window.addEventListener("keydown", skip);
    return () => window.removeEventListener("keydown", skip);
  }, [skip]);

  return (
    <div
      className="splash"
      data-splash-theme={theme}
      data-splash-state={leaving ? "leaving" : "playing"}
      onPointerDown={skip}
      aria-hidden={leaving}
    >
      <SplashStage ref={stage} label={t("app.splash")} />
    </div>
  );
}
