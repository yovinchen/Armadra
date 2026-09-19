import type { DriveEvent } from "../../shell-core/browser/drive";

/**
 * One publisher for everything the shell wants to tell the Runtime.
 *
 * It exists so the verb layer and the assembly can both reach the drive
 * channel without importing each other. A module-level function rather than an
 * emitter: there is exactly one subscriber (the Runtime), and a fan-out here
 * would only be a way to accidentally acquire a second one.
 */

type Publisher = (event: DriveEvent) => void;

let publisher: Publisher = () => {};

export function setPublisher(next: Publisher): void {
  publisher = next;
}

export function publishEvent(event: DriveEvent): void {
  publisher(event);
}
