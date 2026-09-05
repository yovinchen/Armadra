/**
 * 开屏动画的时间轴：4 秒里签名先写完、犰狳从左侧走进来、最后定格成品牌标识。
 *
 * 这里只有纯计算——给定毫秒数算出这一帧每个元素该摆在哪。DOM 由
 * `SplashStage.tsx` 按结果写属性，测试则直接比对数字，不需要 SVG 几何。
 * 数值来自设计稿 `Armadra_signature_v14.html`，改动会改变成片节奏。
 */

/** 整段时长；结束后画面停在终态。 */
export const SPLASH_DURATION_MS = 4000;
/** 按 30fps 取整推进：和设计稿的逐帧导出对齐，也省掉高刷屏上的无用重绘。 */
export const SPLASH_FPS = 30;
/** 写完字之后整块签名下移到最终位置所用的时间。 */
const SETTLE_START_MS = 1500;
const SETTLE_DURATION_MS = 470;
/** 笔迹本身的书写时长（一条连续中心线）。 */
export const WRITING_DURATION_MS = 1500;

export const SPLASH_TIMING = Object.freeze({
  /** 犰狳开始从左侧遮罩后走出来。 */
  entranceStart: 1100,
  /** 一个步态周期 = 两小步。 */
  walkDuration: 1800,
  /** 走姿擦成静止姿势。 */
  restStart: 2900,
  restDuration: 100,
  /** 静止姿势淡成品牌标识。 */
  logoStart: 3000,
  logoDuration: 240,
});

/** 精灵图是 2×2 的四张走姿，每格 768×512。 */
const SHEET_FRAME_WIDTH = 768;
const SHEET_FRAME_HEIGHT = 512;
/** 每张走姿在格子里的手工微调（设计稿实测值），按 0–3 号姿势排列。 */
const POSE_OFFSETS = [
  { x: 0, y: 0 },
  { x: 78, y: 0 },
  { x: 0, y: 25 },
  { x: 78, y: 25 },
] as const;

export function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/** smoothstep 的五次版本，首尾二阶导也为零，起步和收尾都看不出接缝。 */
export function smooth(value: number): number {
  const x = clamp01(value);
  return x * x * x * (x * (x * 6 - 15) + 10);
}

/** 一帧的全部可变属性；字段名对应 SVG 里的元素。 */
export interface SplashFrame {
  /** `#signature` 的 transform。 */
  signature: string;
  /** `#walker` 的 transform 与可见性。 */
  walker: string;
  walkerOpacity: number;
  /** 精灵图在 `#walker-frame` 内的偏移，用来切走姿。 */
  sheetX: number;
  sheetY: number;
  /** 入场遮罩：一块自左向右收回的窗口，先露鼻子再露壳和尾巴。 */
  entranceX: number;
  entranceWidth: number;
  /** 走姿 / 静止姿势之间的一次不重叠擦除。 */
  walkingWidth: number;
  restingX: number;
  restingWidth: number;
  idleOpacity: number;
  logoOpacity: number;
  /** 笔迹揭开的进度，0 = 还没写，1 = 写完。 */
  writingProgress: number;
  /** 笔尖的不透明度；0 时不必再去算它在路径上的位置。 */
  tipOpacity: number;
}

/**
 * 算出 `milliseconds` 这一刻的画面。
 *
 * 超出 `[0, SPLASH_DURATION_MS]` 的输入会被夹住，所以传 `SPLASH_DURATION_MS`
 * 就是终态——`prefers-reduced-motion` 下只渲染这一帧。
 */
export function splashFrameAt(milliseconds: number): SplashFrame {
  const time = Math.max(0, Math.min(SPLASH_DURATION_MS, milliseconds));

  // 先写完全部笔画，再把整块签名往下挪，两件事不重叠。
  const settle = smooth((time - SETTLE_START_MS) / SETTLE_DURATION_MS);
  const signature = `translate(960 ${540 + 170 * settle}) scale(.88) translate(-920 -500)`;

  const reveal = smooth(
    (time - SPLASH_TIMING.logoStart) / SPLASH_TIMING.logoDuration,
  );

  // 一个步态周期两小步，整只犰狳只挪 96 个设计像素。
  const arrival = clamp01(
    (time - SPLASH_TIMING.entranceStart) / SPLASH_TIMING.walkDuration,
  );
  const step = Math.min(1, Math.floor(arrival * 2));
  const stepPhase = clamp01(arrival * 2 - step);
  const travel = (step + smooth(stepPhase)) / 2;
  // `arrival` 已经夹在 [0, 1]，所以 pose 只可能是 0–3。
  const pose = Math.min(3, Math.floor(arrival * 4)) as 0 | 1 | 2 | 3;
  const offset = POSE_OFFSETS[pose];
  const sheetX = -(pose % 2) * SHEET_FRAME_WIDTH + offset.x;
  const sheetY = -Math.floor(pose / 2) * SHEET_FRAME_HEIGHT + offset.y;
  const lift = -1.8 * Math.pow(Math.sin(stepPhase * Math.PI), 2);
  const walker = `translate(${864 + 96 * travel} ${345 + lift})`;

  const entrance = smooth(arrival / 0.9);
  const entranceX = 990 - 215 * entrance;

  // 一次短促、不重叠的姿势擦除，收在与原画完全一致的静止姿势上。
  // 两个姿势都朝右：没有转身、翻转，也没有半透明的双重曝光。
  const settlePose = smooth(
    (time - SPLASH_TIMING.restStart) / SPLASH_TIMING.restDuration,
  );
  const seam = 1130 - 370 * settlePose;

  return {
    signature,
    walker,
    walkerOpacity:
      time >= SPLASH_TIMING.entranceStart && settlePose < 1 ? 1 : 0,
    sheetX,
    sheetY,
    entranceX,
    entranceWidth: 1180 - entranceX,
    walkingWidth: Math.max(0, seam - 700),
    restingX: seam,
    restingWidth: 1180 - seam,
    idleOpacity: settlePose > 0 && reveal < 1 ? 1 : 0,
    logoOpacity: reveal,
    writingProgress: clamp01(time / WRITING_DURATION_MS),
    // 起笔 25ms 淡入、收笔前 30ms 淡出；写完就彻底熄掉。
    tipOpacity:
      time < WRITING_DURATION_MS
        ? clamp01(Math.min(1, time / 25, (WRITING_DURATION_MS - time) / 30))
        : 0,
  };
}
