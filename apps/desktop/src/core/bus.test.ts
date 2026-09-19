import { describe, expect, it, vi } from "vitest";
import { EventBus } from "./bus";

describe("the event bus", () => {
  it("delivers to every subscriber", () => {
    const bus = new EventBus();
    const first = vi.fn();
    const second = vi.fn();
    bus.on("runtime.hello", first);
    bus.on("runtime.hello", second);
    bus.emit("runtime.hello", { instanceId: "a", version: "0.1.0" });
    expect(first).toHaveBeenCalledWith({ instanceId: "a", version: "0.1.0" });
    expect(second).toHaveBeenCalledOnce();
  });

  it("unsubscribes, and does not mind being asked twice", () => {
    const bus = new EventBus();
    const subscriber = vi.fn();
    const off = bus.on("runtime.hello", subscriber);
    off();
    off();
    bus.emit("runtime.hello", { instanceId: "a", version: "0.1.0" });
    expect(subscriber).not.toHaveBeenCalled();
    expect(bus.subscriberCount("runtime.hello")).toBe(0);
  });

  it("emits to nobody without complaining", () => {
    const bus = new EventBus();
    expect(() =>
      bus.emit("runtime.hello", { instanceId: "a", version: "0.1.0" }),
    ).not.toThrow();
  });

  it("does not let one failing subscriber stop the others or the publisher", () => {
    // A board that saved is saved whether or not a listener could be told.
    const bus = new EventBus();
    const errors: unknown[] = [];
    bus.on("runtime.hello", () => {
      throw new Error("listener is broken");
    });
    const healthy = vi.fn();
    bus.on("runtime.hello", healthy);
    bus.emit("runtime.hello", { instanceId: "a", version: "0.1.0" }, (error) =>
      errors.push(error),
    );
    expect(healthy).toHaveBeenCalledOnce();
    expect(errors).toHaveLength(1);
  });

  it("frames an event the way the wire carries it", () => {
    const bus = new EventBus();
    expect(
      bus.frame("runtime.hello", { instanceId: "a", version: "0.1.0" }),
    ).toEqual({
      type: "runtime.hello",
      payload: { instanceId: "a", version: "0.1.0" },
    });
  });

  it("counts subscribers per event", () => {
    const bus = new EventBus();
    expect(bus.subscriberCount("runtime.hello")).toBe(0);
    bus.on("runtime.hello", () => {});
    bus.on("runtime.hello", () => {});
    expect(bus.subscriberCount("runtime.hello")).toBe(2);
  });
});
