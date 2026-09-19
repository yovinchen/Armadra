/**
 * 隐藏回收（electron-migration.md §4.1「guest 生命周期」行，
 * [浏览器节点](../../../../docs/research/nodeterm/browser-node.md) §2.5）。
 *
 * 一个 guest 就是一个 Chromium 渲染进程。隐藏五分钟还不回收，二十个后台标
 * 签就是二十个进程；回收得太急，人切走倒杯水回来就发现表单空了。三条豁免各
 * 有各的理由，见 `shouldDiscard`。
 */

/** 隐藏多久算「不会马上回来」。 */
export const BROWSER_DISCARD_MS = 5 * 60 * 1000;

/** 定时器多久醒一次去问一遍。比阈值密得多，因为阈值可能被设置改小。 */
export const DISCARD_TICK_MS = 15 * 1000;

export interface DiscardInputs {
  /** 设置里的总开关。**在定时器触发时重读**，不是设定时读。 */
  enabled: boolean;
  /** 正在加载。回收会丢掉 POST 的结果和中间页。 */
  loading: boolean;
  /** 正在出声。Chrome 同理——回收一个正在放的视频是明显的错。 */
  audible: boolean;
  /**
   * Agent 正在驱动。回收会让目标被销毁，表单、滚动、登录后的 SPA 状态全丢，
   * 上一次 read 拿到的 ref 全部静默失效。
   *
   * W3.1/W3.2 里恒为 `false`：驱动还没接通（W3.3）。字段先留好，免得接通时
   * 要动这个判定本身——那时候改的是调用方，不是规则。
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
  return inputs.hiddenMs > BROWSER_DISCARD_MS;
}
