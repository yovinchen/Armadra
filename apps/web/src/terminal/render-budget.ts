/**
 * 渲染名额（终端宿主设计 §7.1：「WebGL context 设设备预算（初始 4 个，可按测量
 * 调整），优先焦点实例，回收只释放渲染资源」）。
 *
 * 一块画布上可以摆几十个终端。WebGL 上下文是设备级的稀缺资源——Chromium 每页
 * 默认只给 ~16 个，超了之后浏览器会**强制驱逐**一个现有上下文来腾地方，而被
 * 选中的那个可能正是用户眼前的终端：它随即画成 Chromium 的 "lost context"
 * 死画布占位（白框 + 哭脸），直到我们自己的 `onContextLoss` → dispose →
 * 退回 DOM 渲染器慢一拍地接上。
 *
 * 所以名额要我们自己发。决策权收敛到**一个**模块级协调器：每个节点的
 * `IntersectionObserver` 只**上报**可见性（`setVisible`），授予与回收全部由这里
 * 算。各节点各自决定「可见就取、隐藏一会儿再放」时，每一条单独看都对，合起来
 * 却没人对总数负责——快速平移或缩小时，刚离开的还没放、新进来的已经取，瞬间
 * 越过上限，浏览器就替我们做了驱逐。
 *
 * 五条不能破的规矩：
 *  - 回收**只释放渲染资源**（WebGL addon、每帧写入），不动 `Terminal` 实例，
 *    更不动 PTY。丢名额不等于丢内容。
 *  - 焦点实例永远有名额，哪怕因此超出上限一个：用户正在打字的那个终端不能黑。
 *  - 授予要过 `RENDER_ACQUIRE_DEBOUNCE_MS` 的去抖：快速平移把节点从视口扫过两
 *    帧，不该为它建一个上下文再立刻拆掉。
 *  - 超预算时按 `hiddenAt` LRU 从**最久未见的隐藏持有者**按需回收；持有者若当前
 *    全部可见，新来者**不授予、留在 DOM 渲染器**——绝不越预算，浏览器就永远
 *    没有强制驱逐的理由。
 *  - 隐藏持有者保留名额（暖着），没有基于时间的主动释放；唯一的主动释放是内存
 *    压力下的 `releaseHidden()`。
 *
 * 策略是纯函数 `selectGranted`，登记处只负责「变了就通知」。
 *
 * ---
 *
 * **壳侧要配的那一个开关**：桌面壳（Electron 迁移 W1/W2）必须给 Chromium 传
 * `--max-active-webgl-contexts=32` 把每页上限抬到 32，`RENDER_BUDGET_OTHER`
 * 的 24 才有意义；浏览器里跑（没有壳）时抬不了顶，用户要自己在设置里调低档位。
 * 不变量到哪都一样：我们的预算**明显低于**这台机器的真实上限。
 */

/* -------------------------------- 预算数值 -------------------------------- */

/**
 * macOS 桌面的默认预算。
 *
 * 比其他平台低一档，原因只有一条**未复现**的整窗闪烁报告（某些 macOS GPU 上
 * 同时活着的上下文一多，系统合成器会闪）。曾经被归到 macOS 头上的「缩小后终端
 * 合成成黑块」后来被根因定位成 addon 的 dispose 崩溃，与上下文数量无关——那条
 * 证据不再支持任何特定上限。16 是折中：漫游一块繁忙画布时很少撞到预算争用
 * （撞上就会在平移前沿看见 DOM→WebGL 的升级闪一下），又不一步回到报告当时的
 * 那个配置。
 */
export const RENDER_BUDGET_MAC = 16;

/** 其他平台的默认预算；壳把 Chromium 上限抬到 32 之后仍留足余量。 */
export const RENDER_BUDGET_OTHER = 24;

/**
 * 可设范围。下限 1：0 会让每一个终端都退到批量渲染，等于把功能关掉；
 * 上限 24：再多就越过壳抬顶后的余量，白白把强制驱逐请回来。
 */
export const RENDER_BUDGET_RANGE = [1, 24] as const;

/** 设置页给出的档位。 */
export const RENDER_BUDGET_CHOICES = [4, 8, 16, 24] as const;

/**
 * 这台机器是不是 macOS。
 *
 * 故意不复用 `@/keybindings` 的 `isMacPlatform`：那个模块 import
 * `app/preferences-store`，而 preferences-store 又 import 本文件取默认值——
 * 循环 import 会让默认值在模块初始化时读成 `undefined`。判定只有三行，抄比
 * 绕过去便宜。
 */
function isMacDevice(): boolean {
  if (typeof navigator === "undefined") return false;
  const uaData = (
    navigator as Navigator & { userAgentData?: { platform?: string } }
  ).userAgentData;
  const source = uaData?.platform || navigator.platform || navigator.userAgent;
  return /mac|iphone|ipad|ipod/i.test(source);
}

/** 本机默认预算：mac 16，其他 24。设置里存过档位的话由 preferences 覆盖。 */
export const DEFAULT_RENDER_BUDGET = isMacDevice()
  ? RENDER_BUDGET_MAC
  : RENDER_BUDGET_OTHER;

/* -------------------------------- 时序常量 -------------------------------- */

/**
 * 一个实例要连续可见多久才授予名额。
 *
 * 吸收快速平移：节点在视口里只扫过一两帧时**不该**去抢上下文——建一个 WebGL
 * 上下文要编译着色器、建字形图集，为两帧付这笔钱还顺带把别人挤掉，是净亏。
 */
export const RENDER_ACQUIRE_DEBOUNCE_MS = 150;

/**
 * 上下文被外部弄丢（休眠唤醒、GPU 进程重启）之后，仍可见的实例延迟多久重授。
 *
 * 比取名额的去抖长得多是故意的：刚唤醒时 GPU 还在安顿，立刻重试往往再丢一次。
 * 没有这一次重授，唤醒后的终端会无限期停在 DOM 渲染器上——丢上下文时可见性
 * 一点没变，不会有任何事件把它们叫醒，只能等用户碰巧把节点移出再移回。
 */
export const RENDER_REACQUIRE_AFTER_LOSS_MS = 1_000;

/**
 * 连续丢多少次（中间没有可见性变化）之后放弃重授，让这个实例留在 DOM 渲染器。
 *
 * 真的不稳定的 GPU 不能一直捶。可见性变化会清零连败计数，所以「放弃」只持续到
 * 用户把节点移出视口再移回来为止。
 */
export const RENDER_LOSS_STREAK_MAX = 3;

/* -------------------------------- 名额策略 -------------------------------- */

/** 焦点实例：见 `selectGranted`，这一档不受上限约束。 */
export const RENDER_PRIORITY_FOCUSED = 2;
/** 可见但没有焦点。 */
export const RENDER_PRIORITY_VISIBLE = 1;
/** 看不见但仍持有名额（暖着）。只有这一档会被回收。 */
export const RENDER_PRIORITY_HIDDEN = 0;

export interface RenderClaim {
  /** 登记处内部的唯一键（同一个节点重挂两次会有两条，见下）。 */
  id: string;
  priority: number;
  /**
   * 单调递增的活跃序号，转为可见与转为隐藏时各记一次。
   *
   * 两档里读法相反，这正是两条规矩的形状：可见档里 `seq` **小**的是老住户
   * （先可见的先得，新来者不挤走正在看的）；隐藏档里 `seq` 就是 `hiddenAt`，
   * **大**的是刚刚才隐藏的（最久未见的先被回收）。
   */
  seq: number;
}

/**
 * 谁拿到名额。
 *
 * 1. `priority >= RENDER_PRIORITY_FOCUSED` 的全部直接给——**即使超出上限**。
 * 2. 可见档排在隐藏档**整体之前**：可见的新来者总能拿走某个隐藏持有者的名额，
 *    而隐藏持有者永远拿不走可见实例的。
 * 3. 可见档内部按 `seq` 升序（先可见的先得，id 升序打平）。**老住户优先**是
 *    这一条的要点：名额满且持有者全部可见时，新来者不授予、留在 DOM 渲染器，
 *    而不是把用户正在看的那个降级。
 * 4. 隐藏档内部按 `seq`（即 `hiddenAt`）降序：最久没被看见的排最后，先被回收。
 *
 * 返回值按输入顺序无关的集合给出，调用方只关心「在不在里面」。
 */
export function selectGranted(
  claims: readonly RenderClaim[],
  limit: number,
): Set<string> {
  const granted = new Set<string>();
  const visible: RenderClaim[] = [];
  const hidden: RenderClaim[] = [];
  for (const claim of claims) {
    if (claim.priority >= RENDER_PRIORITY_FOCUSED) granted.add(claim.id);
    else if (claim.priority >= RENDER_PRIORITY_VISIBLE) visible.push(claim);
    else hidden.push(claim);
  }
  const remaining = Math.max(0, Math.trunc(limit) - granted.size);
  if (remaining === 0) return granted;
  visible.sort((a, b) => a.seq - b.seq || (a.id < b.id ? -1 : 1));
  hidden.sort((a, b) => b.seq - a.seq || (a.id < b.id ? -1 : 1));
  for (const claim of [...visible, ...hidden].slice(0, remaining)) {
    granted.add(claim.id);
  }
  return granted;
}

export function clampRenderBudget(limit: number): number {
  if (!Number.isFinite(limit)) return DEFAULT_RENDER_BUDGET;
  return Math.min(
    RENDER_BUDGET_RANGE[1],
    Math.max(RENDER_BUDGET_RANGE[0], Math.round(limit)),
  );
}

/* -------------------------------- 登记处 ---------------------------------- */

/**
 * 暂缓申领的原因。两种缓期语义不同，不能合成一个布尔：
 *  - `debounce`——刚变可见，等去抖窗口。聚焦可以立刻取消它（用户在打字）。
 *  - `loss`——刚丢了上下文，等退避。**聚焦不能取消**，否则丢一次就被聚焦捶一次；
 *    连败超上限后干脆不再挂计时器，一直缓到下一次可见性变化。
 */
type Hold = "debounce" | "loss";

interface Entry {
  /** 登记处内部的唯一键，也是 `RenderClaim.id`。 */
  key: string;
  visible: boolean;
  focused: boolean;
  /** 我们认为它此刻真的持有一个上下文（算进预算，也是上次通知出去的值）。 */
  granted: boolean;
  seq: number;
  hold: Hold | null;
  timer: ReturnType<typeof setTimeout> | null;
  /** 中间没有可见性变化的连续外部丢失次数。 */
  lossStreak: number;
  onChange: (granted: boolean) => void;
}

let limit = DEFAULT_RENDER_BUDGET;
/** LRU 用的单调时钟，与真实时间、假计时器都无关。 */
let clock = 0;
/** 登记键的自增号，只保证唯一。 */
let serial = 0;
const entries = new Map<string, Entry>();

export function getRenderBudget(): number {
  return limit;
}

/** 改上限并立刻重算一遍。设置页改档位时用。 */
export function setRenderBudget(next: number): void {
  const clamped = clampRenderBudget(next);
  if (clamped === limit) return;
  limit = clamped;
  reevaluate();
}

/** 一个终端实例在协调器里的把手。节点只上报，不决策。 */
export interface RenderClient {
  /** 上报视口可见性（`IntersectionObserver` 的唯一出口）。 */
  setVisible: (visible: boolean) => void;
  /** 上报键盘焦点。 */
  setFocused: (focused: boolean) => void;
  /** 上报 `webglcontextlost`：名额从账上划掉，并安排一次延迟重授。 */
  contextLost: () => void;
  /** 节点卸载：还名额、停计时器、销登记。 */
  dispose: () => void;
}

/**
 * 登记一个终端实例，登记即按 `initial` 的状态算一轮名额。
 *
 * **初始状态不去抖**：刚挂载的节点是用户刚建出来/刚打开画布的结果，不是平移扫
 * 过——它该立刻上 GPU。去抖只管登记之后的 `setVisible(true)` 跃迁，那才是平移。
 *
 * 键里带一个自增号：StrictMode 的双次 effect、热重载的重挂都可能让同一个
 * `nodeId` 同时有两条登记，用节点 id 直接当键会让后来者把前一条覆盖掉，
 * 前一条的 `onChange` 从此再也收不到通知。
 */
export function registerRenderClient(
  id: string,
  initial: { visible: boolean; focused: boolean },
  onChange: (granted: boolean) => void,
): RenderClient {
  serial += 1;
  const key = `${id}#${serial}`;
  const entry: Entry = {
    key,
    visible: initial.visible,
    focused: initial.focused,
    granted: false,
    seq: ++clock,
    hold: null,
    timer: null,
    lossStreak: 0,
    onChange,
  };
  entries.set(key, entry);
  reevaluate();

  /** 登记还在表里、而且还是这一条（不是同 id 的后来者）。 */
  const live = () => entries.get(key) === entry;

  return {
    setVisible(visible) {
      if (!live() || entry.visible === visible) return;
      entry.visible = visible;
      // 真正的可见性跃迁清零连败：「放弃重授」只持续到用户把节点移出再移回。
      entry.lossStreak = 0;
      clearHold(entry);
      entry.seq = ++clock;
      if (visible && !entry.granted && !entry.focused) {
        // 平移扫过不该抓上下文；已持有的（暖着的）不必再等，聚焦的也不等。
        hold(entry, "debounce", RENDER_ACQUIRE_DEBOUNCE_MS);
      }
      reevaluate();
    },
    setFocused(focused) {
      if (!live() || entry.focused === focused) return;
      entry.focused = focused;
      // 用户开始打字：去抖立刻作废。丢上下文的退避不作废（见 `Hold`）。
      if (focused && entry.hold === "debounce") clearHold(entry);
      reevaluate();
    },
    contextLost() {
      if (!live()) return;
      // 上下文已经没了（浏览器强制驱逐、GPU 重启，或我们自己 dispose 的回调）：
      // 先把账划掉并通知，腾出来的名额在 `reevaluate` 里发给别人。
      if (entry.granted) {
        entry.granted = false;
        entry.onChange(false);
      }
      clearHold(entry);
      entry.lossStreak += 1;
      // 退避期间不申领，否则这一轮重算会立刻把它原地再授一次。
      entry.hold = "loss";
      if (entry.visible && entry.lossStreak <= RENDER_LOSS_STREAK_MAX) {
        hold(entry, "loss", RENDER_REACQUIRE_AFTER_LOSS_MS);
      }
      reevaluate();
    },
    dispose() {
      if (!live()) return;
      clearHold(entry);
      entries.delete(key);
      reevaluate();
    },
  };
}

/**
 * 把这些 canvas 的 WebGL 上下文**显式弄丢**（`WEBGL_lose_context`）。
 *
 * Chromium 把一个上下文计进每页上限，直到它被 GC **或**被显式弄丢——而
 * `WebglAddon.dispose()` 两件事都不做。不补这一刀，每次释放都会留下一个僵尸
 * 上下文继续占着名额，于是「真实上下文数 = 我们发的名额 + 僵尸」在平移churn 下
 * 越过上限，即便协调器自己一次都没超预算。
 *
 * 这不是推测：2026-09-19 在真 Runtime + 20 个终端上快速平移测出来 `peak 18`
 * 个活上下文、6 次 `webglcontextlost`——正是浏览器的强制驱逐。补上之后归零。
 *
 * 参数收的是 **canvas 元素**，必须在 dispose **之前**抓：dispose 会把它们从
 * DOM 上摘掉，之后再查容器什么也找不到，而握着的元素引用（和它们的上下文）仍然
 * 有效。对非 WebGL 的 canvas 安全：已经持有 2d 上下文的 canvas 上
 * `getContext('webgl2')` 返回 null，不会凭空建一个。返回真的弄丢了几个。
 */
export function loseWebglContexts(
  canvases: ArrayLike<HTMLCanvasElement> | null | undefined,
): number {
  if (!canvases) return 0;
  let lost = 0;
  for (const canvas of Array.from(canvases)) {
    try {
      const gl = canvas.getContext("webgl2") as WebGL2RenderingContext | null;
      const extension = gl?.getExtension("WEBGL_lose_context") as {
        loseContext: () => void;
      } | null;
      if (!extension) continue;
      extension.loseContext();
      lost += 1;
    } catch {
      // 弄丢上下文是优化，永远不值得为它让释放路径抛出去。
    }
  }
  return lost;
}

/**
 * 内存压力下把**所有隐藏持有者**的名额还回去。
 *
 * 这是生命周期里唯一一次主动释放：隐藏持有者平时暖着，只在有可见的新来者要
 * 名额时按 LRU 让出一个。可见的持有者一概不动——把上下文从用户正盯着的终端上
 * 摘走，是拿一次可见的降级去换内存，和 `selectGranted` 里那条规矩同一个理由。
 *
 * 目前没有事件源接进来（壳侧的内存压力事件是 Electron 迁移 W1/W2 的事），这里
 * 先把杠杆和它的语义定下来。
 */
export function releaseHidden(): void {
  const released: Entry[] = [];
  for (const entry of entries.values()) {
    if (!entry.granted || entry.visible) continue;
    entry.granted = false;
    released.push(entry);
  }
  if (released.length === 0) return;
  for (const entry of released) entry.onChange(false);
  // 还回去的名额重新发一轮：隐藏且没名额的不是申领者，不会原地拿回去。
  reevaluate();
}

/** 测试用：清空登记、停掉计时器并恢复默认上限。 */
export function resetRenderBudget(): void {
  for (const entry of entries.values()) clearHold(entry);
  entries.clear();
  clock = 0;
  serial = 0;
  limit = DEFAULT_RENDER_BUDGET;
}

function clearHold(entry: Entry): void {
  if (entry.timer) clearTimeout(entry.timer);
  entry.timer = null;
  entry.hold = null;
}

/** 挂一个缓期计时器；到点解除缓期并重算。 */
function hold(entry: Entry, reason: Hold, delay: number): void {
  clearHold(entry);
  entry.hold = reason;
  entry.timer = setTimeout(() => {
    entry.timer = null;
    entry.hold = null;
    reevaluate();
  }, delay);
}

/**
 * 一条登记这一轮参不参与申领。
 *
 * 隐藏但持有名额的进隐藏档（暖着，也是唯一可回收的一档）；隐藏且没名额的完全
 * 不参与——看不见的终端不会因为看不见而拿到上下文。缓期中的一律不参与。
 */
function claimOf(entry: Entry): RenderClaim | null {
  if (entry.granted && !entry.visible) {
    return { id: entry.key, priority: RENDER_PRIORITY_HIDDEN, seq: entry.seq };
  }
  if (!entry.visible || entry.hold) return null;
  return {
    id: entry.key,
    priority: entry.focused ? RENDER_PRIORITY_FOCUSED : RENDER_PRIORITY_VISIBLE,
    seq: entry.seq,
  };
}

/**
 * 重算并只通知**变了**的那些。
 *
 * 先把新状态全部写回去再回调：回调里可能同步地再申请或释放一次（比如
 * 丢名额后立刻降级重挂），此时登记表必须已经是自洽的。
 */
function reevaluate(): void {
  const claims: RenderClaim[] = [];
  for (const entry of entries.values()) {
    const claim = claimOf(entry);
    if (claim) claims.push(claim);
  }
  const granted = selectGranted(claims, limit);
  const changed: Entry[] = [];
  for (const entry of entries.values()) {
    const next = granted.has(entry.key);
    if (next === entry.granted) continue;
    entry.granted = next;
    changed.push(entry);
  }
  for (const entry of changed) entry.onChange(entry.granted);
}
