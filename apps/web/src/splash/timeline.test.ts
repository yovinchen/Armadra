import { describe, expect, it } from "vitest";
import {
  clamp01,
  smooth,
  splashFrameAt,
  SPLASH_DURATION_MS,
  SPLASH_TIMING,
  WRITING_DURATION_MS,
} from "./timeline";

describe("splash timeline", () => {
  it("clamps and smooths at the ends", () => {
    expect(clamp01(-5)).toBe(0);
    expect(clamp01(5)).toBe(1);
    expect(smooth(-1)).toBe(0);
    expect(smooth(0.5)).toBe(0.5);
    expect(smooth(2)).toBe(1);
  });

  it("starts with nothing written and nobody on stage", () => {
    const frame = splashFrameAt(0);
    expect(frame.writingProgress).toBe(0);
    expect(frame.tipOpacity).toBe(0);
    expect(frame.walkerOpacity).toBe(0);
    expect(frame.idleOpacity).toBe(0);
    expect(frame.logoOpacity).toBe(0);
  });

  it("writes the signature before the mascot arrives", () => {
    const mid = splashFrameAt(WRITING_DURATION_MS / 2);
    expect(mid.writingProgress).toBeCloseTo(0.5, 5);
    expect(mid.tipOpacity).toBe(1);
    // 犰狳的入场比写字晚，写到一半时它还没露面。
    expect(mid.walkerOpacity).toBe(0);

    const written = splashFrameAt(WRITING_DURATION_MS);
    expect(written.writingProgress).toBe(1);
    expect(written.tipOpacity).toBe(0);
  });

  it("walks the mascot in and hands over to the brand mark", () => {
    const walking = splashFrameAt(SPLASH_TIMING.entranceStart + 400);
    expect(walking.walkerOpacity).toBe(1);
    expect(walking.logoOpacity).toBe(0);
    // 入场窗口正在向左退开，露出的宽度比起始的 100 更大。
    expect(walking.entranceWidth).toBeGreaterThan(100);

    const settling = splashFrameAt(SPLASH_TIMING.restStart + 50);
    expect(settling.idleOpacity).toBe(1);

    const done = splashFrameAt(SPLASH_DURATION_MS);
    expect(done.walkerOpacity).toBe(0);
    expect(done.idleOpacity).toBe(0);
    expect(done.logoOpacity).toBe(1);
  });

  it("cycles four walk poses out of the 2×2 sprite sheet", () => {
    const poses = [0, 0.3, 0.55, 0.8, 1].map((fraction) =>
      splashFrameAt(
        SPLASH_TIMING.entranceStart + SPLASH_TIMING.walkDuration * fraction,
      ),
    );
    expect(poses.map((frame) => [frame.sheetX, frame.sheetY])).toEqual([
      [0, 0],
      [-690, 0],
      [0, -487],
      [-690, -487],
      [-690, -487],
    ]);
  });

  it("clamps out-of-range times to the first and last frame", () => {
    expect(splashFrameAt(-1000)).toEqual(splashFrameAt(0));
    expect(splashFrameAt(SPLASH_DURATION_MS + 5000)).toEqual(
      splashFrameAt(SPLASH_DURATION_MS),
    );
  });
});
