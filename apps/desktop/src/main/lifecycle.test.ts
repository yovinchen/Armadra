import { describe, expect, it } from "vitest";
import {
  DesktopLifecycle,
  quitFailureDialog,
  runQuitSequence,
} from "./lifecycle";
import type { RuntimeProcess } from "./runtime-process";

/**
 * 退出这一段：core 确认停了才退出，没确认就不退。
 */

/** 一个 core 的替身：记下别人要求了什么，并按吩咐回答。 */
function fakeRuntime(
  behaviour: "ok" | "fail",
): RuntimeProcess & { stopped: number } {
  let stopped = 0;
  return {
    get stopped() {
      return stopped;
    },
    async stop() {
      stopped += 1;
      if (behaviour === "fail")
        throw new Error("Core failed to stop all managed sessions");
    },
  } as unknown as RuntimeProcess & { stopped: number };
}

describe("退出这一段", () => {
  it("core 停下来之后才允许退出", async () => {
    const lifecycle = new DesktopLifecycle();
    const runtime = fakeRuntime("ok");
    lifecycle.state.beginQuit();
    expect(await runQuitSequence(lifecycle, runtime)).toEqual({ ok: true });
    expect(runtime.stopped).toBe(1);
    expect(lifecycle.state.canExit()).toBe(true);
  });

  it("core 没确认就不退出，窗口回来并说出原因", async () => {
    const lifecycle = new DesktopLifecycle();
    const runtime = fakeRuntime("fail");
    lifecycle.state.beginQuit();
    const outcome = await runQuitSequence(lifecycle, runtime);
    expect(outcome.ok).toBe(false);
    expect(outcome.message).toMatch(/managed sessions/);
    // 应用还开着，还能用。
    expect(lifecycle.state.canExit()).toBe(false);
    expect(lifecycle.state.isQuitting()).toBe(false);
    expect(lifecycle.state.reveal()).toBe(true);
    expect(runtime.stopped).toBe(1);
  });
});

describe("the failure dialog", () => {
  it("says the application has not exited, and why", () => {
    const text = quitFailureDialog("Core is still running");
    expect(text.title).toBe("Armadra 退出未完成");
    expect(text.body).toContain("应用尚未退出");
    expect(text.body).toContain("Core is still running");
  });
});
