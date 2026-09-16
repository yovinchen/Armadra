import { describe, expect, test } from "vitest";
import type { Terminal } from "@xterm/xterm";

import {
  compensateScaledPointer,
  scaleOf,
  unscaledPoint,
} from "./scaled-pointer";

/** 一个 400px 宽的容器，被画布缩到 62%，左上角落在 (100, 50)。 */
function scaledElement(scale = 0.62): HTMLElement {
  const element = document.createElement("div");
  Object.defineProperty(element, "offsetWidth", { value: 400 });
  element.getBoundingClientRect = () =>
    ({
      left: 100,
      top: 50,
      width: 400 * scale,
      height: 300 * scale,
      right: 100 + 400 * scale,
      bottom: 50 + 300 * scale,
      x: 100,
      y: 50,
      toJSON: () => ({}),
    }) as DOMRect;
  return element;
}

describe("scaled pointer", () => {
  test("the scale is what the transform did to the layout width", () => {
    expect(scaleOf(scaledElement(0.62))).toBeCloseTo(0.62);
    expect(scaleOf(scaledElement(1))).toBe(1);
  });

  test("a point is folded back into the unscaled space of the element", () => {
    const element = scaledElement(0.5);
    // 200px to the right of the corner on screen is 400px in layout space.
    const point = unscaledPoint({ clientX: 300, clientY: 125 }, element);
    expect(point.clientX).toBeCloseTo(500);
    expect(point.clientY).toBeCloseTo(200);
  });

  test("at scale 1 the event object is passed through untouched", () => {
    const event = { clientX: 123, clientY: 456 };
    expect(unscaledPoint(event, scaledElement(1))).toBe(event);
  });

  test("xterm's mouse service receives the folded coordinates, and can be restored", () => {
    const calls: Array<[number, number, unknown[]]> = [];
    const service = {
      getCoords: (
        event: { clientX: number; clientY: number },
        _element: HTMLElement,
        ...rest: unknown[]
      ) => {
        calls.push([event.clientX, event.clientY, rest]);
        return [1, 1];
      },
      getMouseReportCoords: (
        event: { clientX: number; clientY: number },
        _element: HTMLElement,
      ) => {
        calls.push([event.clientX, event.clientY, []]);
        return { col: 0, row: 0 };
      },
    };
    const original = service.getCoords;
    const terminal = {
      _core: { _mouseService: service },
    } as unknown as Terminal;
    const restore = compensateScaledPointer(terminal);
    const element = scaledElement(0.5);
    service.getCoords({ clientX: 300, clientY: 125 }, element, 80, 24, true);
    service.getMouseReportCoords({ clientX: 300, clientY: 125 }, element);
    expect(calls).toEqual([
      [500, 200, [80, 24, true]],
      [500, 200, []],
    ]);
    restore();
    expect(service.getCoords).toBe(original);
  });

  test("a terminal without the private service is left alone", () => {
    const restore = compensateScaledPointer({} as Terminal);
    expect(() => restore()).not.toThrow();
  });
});
