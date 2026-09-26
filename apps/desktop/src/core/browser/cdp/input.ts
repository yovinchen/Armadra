import { DRIVE_CODES, refuse } from "./codes";
import { commandsFor, isAllowedChord, keyDefinition, parseChord } from "./keys";
import type { Point } from "./locate";
import type { CdpSession } from "./session";

/**
 * Synthesized input: mouse and keyboard as CDP `Input` events against
 * measured coordinates. A page cannot tell these from a person, which is the
 * point — and no script participates, which is the other point.
 *
 * Checked on the desktop shell (Electron 42): these events do NOT raise the
 * guest's `before-input-event` or `focus`, so an Agent's own click is never
 * mistaken for a person taking the page back. `tools/probes/
 * browser-agent-e2e.mjs --electron` keeps checking that.
 */

export function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

export async function moveTo(
  session: CdpSession,
  point: Point,
  buttons = 0,
): Promise<void> {
  await session.input("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: point.x,
    y: point.y,
    ...(buttons === 0 ? {} : { button: "left", buttons }),
  });
}

/**
 * Moves the pointer onto a target and measures it again. Moving the pointer
 * is itself an event — it ends a hover somewhere else, which can collapse a
 * menu and move everything below it — so a point measured before the move
 * may no longer be where the element is.
 */
export async function arrive(
  session: CdpSession,
  measure: () => Promise<Point>,
): Promise<Point> {
  const first = await measure();
  await moveTo(session, first);
  await sleep(50);
  const second = await measure();
  if (Math.abs(second.x - first.x) > 1 || Math.abs(second.y - first.y) > 1)
    await moveTo(session, second);
  return second;
}

export async function clickAt(
  session: CdpSession,
  point: Point,
  count = 1,
): Promise<void> {
  await moveTo(session, point);
  for (let click = 1; click <= count; click += 1) {
    const common = {
      x: point.x,
      y: point.y,
      button: "left",
      clickCount: click,
    };
    await session.input("Input.dispatchMouseEvent", {
      type: "mousePressed",
      buttons: 1,
      ...common,
    });
    await session.input("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      buttons: 0,
      ...common,
    });
  }
}

/**
 * Press, travel, release. Several intermediate moves with the button held,
 * because drag libraries start a drag only after the pointer has moved some
 * distance while pressed.
 *
 * An HTML5 drag (`draggable`) is different: once it starts, it belongs to the
 * operating system's drag session, which synthesized mouse events do not
 * drive (and a headless browser does not have). So drag interception is on
 * for the length of the gesture: if the page starts an HTML5 drag, Chromium
 * hands its drag data back instead of starting an OS drag, and the drop is
 * delivered as drag events at the destination — carrying the page's OWN data
 * back to it, never files from this machine (the allowlist refuses `files`).
 * A pointer-driven drag starts no HTML5 drag and simply sees the moves.
 */
export async function dragBetween(
  session: CdpSession,
  from: Point,
  to: Point,
): Promise<"html5" | "pointer"> {
  session.interceptedDrag = undefined;
  const intercept = await session
    .send("Input.setInterceptDrags", { enabled: true })
    .then(() => true)
    .catch(() => false);
  try {
    await moveTo(session, from);
    await session.input("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: from.x,
      y: from.y,
      button: "left",
      buttons: 1,
      clickCount: 1,
    });
    const steps = 12;
    for (let step = 1; step <= steps; step += 1) {
      const x = Math.round(from.x + ((to.x - from.x) * step) / steps);
      const y = Math.round(from.y + ((to.y - from.y) * step) / steps);
      await moveTo(session, { x, y }, 1);
      await sleep(16);
      if (session.interceptedDrag !== undefined) break;
    }
    // The interception arrives as an event, a moment after the move that
    // started the drag.
    for (
      let wait = 0;
      wait < 10 && intercept && session.interceptedDrag === undefined;
      wait += 1
    )
      await sleep(30);
    const data = session.interceptedDrag;
    if (data !== undefined) {
      for (const type of ["dragEnter", "dragOver", "drop"]) {
        await session.input("Input.dispatchDragEvent", {
          type,
          x: to.x,
          y: to.y,
          data,
        });
      }
    }
    await session.input("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: to.x,
      y: to.y,
      button: "left",
      buttons: 0,
      clickCount: 1,
    });
    return data === undefined ? "pointer" : "html5";
  } finally {
    session.interceptedDrag = undefined;
    if (intercept)
      await session
        .send("Input.setInterceptDrags", { enabled: false })
        .catch(() => undefined);
  }
}

/** Wheel at the middle of the viewport. Chromium clamps one event, so a long
 * move is several. */
export async function wheel(
  session: CdpSession,
  deltaX: number,
  deltaY: number,
): Promise<void> {
  const viewport = session.viewport();
  const x = Math.max(0, Math.round(viewport.width / 2));
  const y = Math.max(0, Math.round(viewport.height / 2));
  let remainingX = deltaX;
  let remainingY = deltaY;
  for (
    let i = 0;
    i < 60 && (Math.abs(remainingX) > 1 || Math.abs(remainingY) > 1);
    i += 1
  ) {
    const dx = Math.sign(remainingX) * Math.min(Math.abs(remainingX), 400);
    const dy = Math.sign(remainingY) * Math.min(Math.abs(remainingY), 400);
    await session.input("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x,
      y,
      deltaX: dx,
      deltaY: dy,
    });
    remainingX -= dx;
    remainingY -= dy;
    await sleep(16);
  }
}

/**
 * What `--key` says, as a key and its modifiers. `--modifiers` adds to what
 * the chord itself spells. A key outside the table is refused here with the
 * list, rather than by the allowlist with nothing.
 */
export function chordOf(
  key: string,
  extra: number,
): { key: string; modifiers: number } {
  const parsed = parseChord(key);
  if (parsed === undefined)
    refuse(DRIVE_CODES.badArgument, `${key} 不是可以按的键`);
  const modifiers = parsed.modifiers | (extra & 15);
  if (
    keyDefinition(parsed.key) === undefined ||
    !isAllowedChord(parsed.key, modifiers)
  ) {
    refuse(
      DRIVE_CODES.badArgument,
      /^[a-zA-Z0-9]$/.test(parsed.key) && (modifiers & 7) === 0
        ? "单个字母或数字是打字，请用 type；组合键要带 Control、Meta 或 Alt"
        : `不能按 ${key}：可按 Enter、Tab、Escape、Backspace、Delete、方向键、Home、End、PageUp、PageDown、Space、F1–F12，以及带 Control / Meta / Alt 的字母与数字（复制、粘贴、剪切、关窗口、退出、开标签与开窗口的组合除外）`,
    );
  }
  return { key: parsed.key, modifiers };
}

export async function pressKey(
  session: CdpSession,
  chord: { key: string; modifiers: number },
  repeat: number,
): Promise<void> {
  const definition = keyDefinition(chord.key)!;
  // Only macOS needs the editing command spelled out: there, a synthesized
  // Meta+A is not a select-all unless it says so. Elsewhere the key binding
  // does it, and naming the command as well would do it twice.
  const commands =
    process.platform === "darwin"
      ? commandsFor(definition.key, chord.modifiers)
      : [];
  for (let i = 0; i < repeat; i += 1) {
    await session.input("Input.dispatchKeyEvent", {
      type: "rawKeyDown",
      key: definition.key,
      code: definition.code,
      windowsVirtualKeyCode: definition.windowsVirtualKeyCode,
      modifiers: chord.modifiers,
      ...(commands.length > 0 ? { commands } : {}),
    });
    await session.input("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: definition.key,
      code: definition.code,
      windowsVirtualKeyCode: definition.windowsVirtualKeyCode,
      modifiers: chord.modifiers,
    });
  }
}

/** Empties the focused field with two editing commands. Neither carries text. */
export async function clearField(session: CdpSession): Promise<void> {
  await session.input("Input.dispatchKeyEvent", {
    type: "rawKeyDown",
    commands: ["selectAll"],
  });
  await session.input("Input.dispatchKeyEvent", {
    type: "rawKeyDown",
    commands: ["deleteBackward"],
  });
}
