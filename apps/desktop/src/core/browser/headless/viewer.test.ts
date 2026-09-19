import { describe, expect, it } from "vitest";

import {
  MAX_VIEWER_TEXT,
  MAX_VIEWPORT_WIDTH,
  clampViewport,
  frameHeader,
  parseViewerMessage,
  viewerCommands,
} from "./viewer";

const viewport = { width: 800, height: 600 };

describe("what a viewer may say", () => {
  it("drops anything it does not recognise, without explaining", () => {
    for (const raw of [
      "",
      "not json",
      JSON.stringify({ type: "evaluate", expression: "1" }),
      JSON.stringify({ type: "mouse", action: "spin", x: 1, y: 1 }),
      JSON.stringify({ type: "key", action: "down", key: "" }),
      JSON.stringify({ type: "text", text: "x".repeat(MAX_VIEWER_TEXT + 1) }),
      "x".repeat(9_000),
      42,
    ]) {
      expect(parseViewerMessage(raw as unknown)).toBeUndefined();
    }
  });

  it("clamps a viewport into something a person could be looking at", () => {
    expect(clampViewport(10, 10)).toEqual({ width: 200, height: 200 });
    expect(clampViewport(99_999, 99_999)).toEqual({
      width: MAX_VIEWPORT_WIDTH,
      height: 1_600,
    });
    expect(clampViewport("wide", null)).toEqual({ width: 1_280, height: 800 });
  });

  it("bounds a click to the viewport this process set", () => {
    const message = parseViewerMessage(
      JSON.stringify({ type: "mouse", action: "down", x: 5_000, y: -20 }),
    );
    const [command] = viewerCommands(message!, viewport);
    expect(command?.method).toBe("Input.dispatchMouseEvent");
    expect(command?.params).toMatchObject({
      type: "mousePressed",
      x: 799,
      y: 0,
      button: "left",
      clickCount: 1,
    });
  });

  it("sends a move with no button and no click count", () => {
    const message = parseViewerMessage(
      JSON.stringify({ type: "mouse", action: "move", x: 10, y: 20 }),
    );
    expect(viewerCommands(message!, viewport)[0]?.params).toMatchObject({
      type: "mouseMoved",
      button: "none",
      clickCount: 0,
    });
  });

  it("carries a printable key as the event's text and a named key without one", () => {
    const letter = parseViewerMessage(
      JSON.stringify({ type: "key", action: "down", key: "q", code: "KeyQ" }),
    );
    expect(viewerCommands(letter!, viewport)[0]?.params).toMatchObject({
      type: "keyDown",
      key: "q",
      text: "q",
    });
    const named = parseViewerMessage(
      JSON.stringify({
        type: "key",
        action: "down",
        key: "ArrowLeft",
        code: "ArrowLeft",
      }),
    );
    expect(viewerCommands(named!, viewport)[0]?.params).not.toHaveProperty(
      "text",
    );
    const up = parseViewerMessage(
      JSON.stringify({ type: "key", action: "up", key: "q", code: "KeyQ" }),
    );
    expect(viewerCommands(up!, viewport)[0]?.params).not.toHaveProperty("text");
  });

  it("bounds a wheel rather than forwarding whatever arrived", () => {
    const message = parseViewerMessage(
      JSON.stringify({
        type: "wheel",
        x: 10,
        y: 10,
        deltaX: 0,
        deltaY: 1e9,
      }),
    );
    expect(viewerCommands(message!, viewport)[0]?.params).toMatchObject({
      type: "mouseWheel",
      deltaY: 4_000,
    });
  });

  it("turns a paste into insertText and nothing else", () => {
    const message = parseViewerMessage(
      JSON.stringify({ type: "text", text: "hello" }),
    );
    expect(viewerCommands(message!, viewport)).toEqual([
      { method: "Input.insertText", params: { text: "hello" } },
    ]);
  });

  it("asks for a device metrics override and no other emulation", () => {
    const message = parseViewerMessage(
      JSON.stringify({ type: "viewport", width: 1_000, height: 700 }),
    );
    const commands = viewerCommands(message!, viewport);
    expect(commands).toHaveLength(1);
    expect(commands[0]?.method).toBe("Emulation.setDeviceMetricsOverride");
  });

  it("reaches for nothing that reads the page", () => {
    // The whole method surface a viewer can produce, listed: a stream socket
    // is reachable by anything that can reach the core, and "the person may
    // type" is not "the socket may ask for cookies".
    const methods = new Set<string>();
    for (const raw of [
      { type: "viewport", width: 900, height: 700 },
      { type: "mouse", action: "down", x: 1, y: 1 },
      { type: "mouse", action: "move", x: 1, y: 1 },
      { type: "mouse", action: "up", x: 1, y: 1 },
      { type: "wheel", x: 1, y: 1, deltaX: 0, deltaY: 10 },
      { type: "key", action: "down", key: "a", code: "KeyA" },
      { type: "text", text: "a" },
    ]) {
      const message = parseViewerMessage(JSON.stringify(raw));
      for (const command of viewerCommands(message!, viewport)) {
        methods.add(command.method);
      }
    }
    expect([...methods].sort()).toEqual([
      "Emulation.setDeviceMetricsOverride",
      "Input.dispatchKeyEvent",
      "Input.dispatchMouseEvent",
      "Input.insertText",
    ]);
  });
});

describe("what travels ahead of a frame", () => {
  it("reports the browser's own size and the viewport it was rendered at", () => {
    const header = frameHeader(
      7,
      { deviceWidth: 1_024, deviceHeight: 768 },
      viewport,
      4_096,
    );
    expect(header).toEqual({
      type: "frame",
      seq: 7,
      width: 1_024,
      height: 768,
      viewportWidth: 800,
      viewportHeight: 600,
      bytes: 4_096,
    });
  });

  it("falls back to the viewport when the metadata said nothing", () => {
    expect(frameHeader(1, undefined, viewport, 10)).toMatchObject({
      width: 800,
      height: 600,
    });
  });
});
