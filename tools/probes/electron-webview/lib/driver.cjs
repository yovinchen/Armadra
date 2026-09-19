"use strict";
/*
 * Everything the probe does to the app goes through here: synthetic input into
 * the HOST window, reads out of the guest via the renderer, and capturePage.
 * No human interaction anywhere.
 *
 * Input is dispatched with CDP `Input.*` on the HOST window's webContents, not
 * with `webContents.sendInputEvent`. Measured on Electron 42.10.1 (see
 * out/result.json `inputRoutingNote`): `sendInputEvent` injects straight into
 * the host RenderWidget and is never hit-tested into the guest OOPIF, so a
 * click aimed at the guest reaches the host document and nothing else. CDP
 * input goes through the browser process' input router, which is the same path
 * a real mouse takes, so it is the only automation that can test hit testing at
 * all.
 */
const fs = require("node:fs");
const path = require("node:path");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const MOD = { alt: 1, control: 2, meta: 4, shift: 8 };
const modifierMask = (names) =>
  names.reduce((acc, n) => acc | (MOD[n] || 0), 0);

const KEYS = {
  Down: { key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 },
  Up: { key: "ArrowUp", code: "ArrowUp", windowsVirtualKeyCode: 38 },
  Return: {
    key: "Enter",
    code: "Enter",
    windowsVirtualKeyCode: 13,
    text: "\r",
  },
  Escape: { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
};

function createDriver(win, outDir) {
  const wc = win.webContents;
  const dbg = wc.debugger;
  if (!dbg.isAttached()) dbg.attach("1.3");
  const cdp = (method, params) => dbg.sendCommand(method, params);

  const host = (code) => wc.executeJavaScript(code, true);
  const canvas = (expr) => host(`window.__canvas.${expr}`);
  const guest = (id, code) =>
    host(
      `window.__canvas.guestEval(${JSON.stringify(id)}, ${JSON.stringify(code)})`,
    );

  async function mouse(type, x, y, extra = {}) {
    await cdp("Input.dispatchMouseEvent", {
      type,
      x: Math.round(x),
      y: Math.round(y),
      button: "none",
      clickCount: 0,
      buttons: 0,
      modifiers: 0,
      ...extra,
    });
  }

  async function move(x, y, buttons = 0, button = "none") {
    await mouse("mouseMoved", x, y, { buttons, button });
    await sleep(16);
  }

  async function click(x, y, { button = "left", modifiers = [] } = {}) {
    const px = Math.round(x);
    const py = Math.round(y);
    const mods = modifierMask(modifiers);
    const buttons = button === "right" ? 2 : 1;
    await move(px, py);
    await mouse("mousePressed", px, py, {
      button,
      clickCount: 1,
      buttons,
      modifiers: mods,
    });
    await sleep(30);
    await mouse("mouseReleased", px, py, {
      button,
      clickCount: 1,
      buttons: 0,
      modifiers: mods,
    });
    await sleep(90);
    return { x: px, y: py };
  }

  async function drag(
    from,
    to,
    { steps = 12, button = "left", settle = 150 } = {},
  ) {
    const x0 = Math.round(from.x);
    const y0 = Math.round(from.y);
    const x1 = Math.round(to.x);
    const y1 = Math.round(to.y);
    await move(x0, y0);
    await mouse("mousePressed", x0, y0, { button, clickCount: 1, buttons: 1 });
    await sleep(40);
    for (let i = 1; i <= steps; i += 1) {
      const x = Math.round(x0 + ((x1 - x0) * i) / steps);
      const y = Math.round(y0 + ((y1 - y0) * i) / steps);
      await mouse("mouseMoved", x, y, { button, buttons: 1 });
      await sleep(16);
    }
    await mouse("mouseReleased", x1, y1, { button, clickCount: 1, buttons: 0 });
    await sleep(settle);
  }

  async function wheel(x, y, deltaY, { modifiers = [], deltaX = 0 } = {}) {
    const px = Math.round(x);
    const py = Math.round(y);
    await move(px, py);
    await cdp("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x: px,
      y: py,
      deltaX,
      deltaY,
      button: "none",
      buttons: 0,
      modifiers: modifierMask(modifiers),
      pointerType: "mouse",
    });
    await sleep(200);
  }

  async function key(keyCode, { modifiers = [], type = true } = {}) {
    const mods = modifierMask(modifiers);
    const named = KEYS[keyCode];
    const base = named || {
      key: keyCode,
      code: `Key${keyCode.toUpperCase()}`,
      windowsVirtualKeyCode: keyCode.toUpperCase().charCodeAt(0),
      text: keyCode,
    };
    const text = type ? (base.text ?? keyCode) : base.text;
    await cdp("Input.dispatchKeyEvent", {
      type: text ? "keyDown" : "rawKeyDown",
      modifiers: mods,
      key: base.key,
      code: base.code,
      windowsVirtualKeyCode: base.windowsVirtualKeyCode,
      nativeVirtualKeyCode: base.windowsVirtualKeyCode,
      ...(text ? { text, unmodifiedText: text } : {}),
    });
    await sleep(20);
    await cdp("Input.dispatchKeyEvent", {
      type: "keyUp",
      modifiers: mods,
      key: base.key,
      code: base.code,
      windowsVirtualKeyCode: base.windowsVirtualKeyCode,
      nativeVirtualKeyCode: base.windowsVirtualKeyCode,
    });
    await sleep(50);
  }

  async function capture(rect, name) {
    const image = await wc.capturePage(
      rect
        ? {
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            width: Math.max(1, Math.round(rect.w ?? rect.width)),
            height: Math.max(1, Math.round(rect.h ?? rect.height)),
          }
        : undefined,
    );
    if (name) {
      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(path.join(outDir, `${name}.png`), image.toPNG());
    }
    return image;
  }

  return {
    win,
    wc,
    cdp,
    host,
    canvas,
    guest,
    move,
    click,
    drag,
    wheel,
    key,
    capture,
    sleep,
  };
}

module.exports = { createDriver, sleep };
