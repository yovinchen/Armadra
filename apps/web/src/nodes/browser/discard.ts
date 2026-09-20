import {
  BROWSER_DEFAULT_DISCARD_MINUTES,
  usePreferencesStore,
} from "@/app/preferences-store";

/**
 * 隐藏回收（electron-migration.md §4.1「guest 生命周期」行）。
 *
 * 一个 guest 就是一个 Chromium 渲染进程。隐藏五分钟还不回收，二十个后台标
 * 签就是二十个进程；回收得太急，人切走倒杯水回来就发现表单空了。三条豁免各
 * 有各的理由，见 `shouldDiscard`。
 */

/** 隐藏多久算「不会马上回来」的默认值；设置里的分钟数覆盖它。 */
export const BROWSER_DISCARD_MS = BROWSER_DEFAULT_DISCARD_MINUTES * 60 * 1000;

/** 定时器多久醒一次去问一遍。比阈值密得多，因为阈值可能被设置改小。 */
export const DISCARD_TICK_MS = 15 * 1000;

export interface DiscardInputs {
  /** 设置里的总开关。**在定时器触发时重读**，不是设定时读。 */
  enabled: boolean;
  /**
   * 隐藏着的 guest 已经超出这台机器愿意留的数量，而这一个排在最外面
   * （`./background` 的 LRU）。
   *
   * 它**跳过时间阈值，但不跳过四条否决**：数量超了是「现在就该放掉一个」
   * 的理由，不是「可以放掉一个正在放视频的页面」的理由。
   */
  overBudget: boolean;
  /** 设置里的阈值（毫秒）。同样在定时器触发时重读。 */
  discardMs: number;
  /** 正在加载。回收会丢掉 POST 的结果和中间页。 */
  loading: boolean;
  /** 正在出声。Chrome 同理——回收一个正在放的视频是明显的错。 */
  audible: boolean;
  /**
   * Agent 正在驱动。回收会让目标被销毁，表单、滚动、登录后的 SPA 状态全丢，
   * 上一次 read 拿到的 ref 全部静默失效。
   */
  driven: boolean;
  /** 已经隐藏了多久。 */
  hiddenMs: number;
}

/**
 * 该不该回收。纯函数，四条否决 + 一条阈值。
 *
 * 写成纯函数不是为了好看：它是唯一一处「什么时候可以把人的页面扔掉」的判
 * 断，必须能被单测按条逐一钉住，而不是散在一个 effect 里。
 */
export function shouldDiscard(inputs: DiscardInputs): boolean {
  if (!inputs.enabled) return false;
  if (inputs.loading) return false;
  if (inputs.audible) return false;
  if (inputs.driven) return false;
  // 四条否决之后才轮到「为什么现在放」：数量超了，或者已经隐藏够久了。
  if (inputs.overBudget) return true;
  return inputs.hiddenMs > inputs.discardMs;
}

/**
 * 定时器醒来时的那一次读取。
 *
 * 走 `getState()` 而不是订阅：这条路上没有渲染，改了设置也不该等下一次重渲
 * 才生效——下一个 tick 读到的就是新值。
 */
export function discardSettings(): { enabled: boolean; discardMs: number } {
  const browser = usePreferencesStore.getState().browser;
  return {
    enabled: browser.discard,
    discardMs: browser.discardMinutes * 60 * 1000,
  };
}
