import type { HostPty, SpawnOptions } from "./pty";

/**
 * A pseudo console that is not one.
 *
 * No machine in this project's CI is a Windows developer machine, and ConPTY
 * exists nowhere else, so everything this host does *around* a console —
 * the generation fence, the replay, the flow gate, the close handshake, the
 * whole wire protocol — would otherwise be untested until somebody ran it on
 * Windows by hand. This fake is what makes that half provable here.
 *
 * It is deliberately **not** a simulation of ConPTY. It has no shell, no
 * escape handling and no timing: it is a handle onto which a test pushes
 * output and an exit, so a test can say "the console never reports an exit"
 * — which is exactly the case a real one cannot be made to produce on demand,
 * and exactly the case the close handshake exists for.
 */
export class FakePty implements HostPty {
  readonly writes: string[] = [];
  readonly resizes: [number, number][] = [];
  killed = 0;
  paused = false;
  /**
   * When false, {@link kill} does **not** lead to an exit. That is the §4.3
   * race in a bottle: node-pty's Windows teardown can drop its own baton
   * before it closes the pseudo console, and the exit never arrives.
   */
  exitsOnKill = true;
  /** Set once an exit has been delivered, so a fake cannot deliver two. */
  private finished = false;
  private readonly dataListeners: ((data: Buffer | string) => void)[] = [];
  private readonly exitListeners: ((event: {
    exitCode: number;
    signal?: number;
  }) => void)[] = [];

  constructor(
    readonly options: SpawnOptions,
    readonly pid: number = 4321,
  ) {}

  onData(listener: (data: Buffer | string) => void): { dispose(): void } {
    this.dataListeners.push(listener);
    return { dispose: () => {} };
  }

  onExit(listener: (event: { exitCode: number; signal?: number }) => void): {
    dispose(): void;
  } {
    this.exitListeners.push(listener);
    return { dispose: () => {} };
  }

  write(data: string): void {
    this.writes.push(data);
  }

  resize(cols: number, rows: number): void {
    this.resizes.push([cols, rows]);
  }

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
  }

  kill(): void {
    this.killed += 1;
    if (this.exitsOnKill) this.exit(130);
  }

  /** Pushes console output at whoever is reading. */
  emit(chunk: Buffer | string): void {
    if (this.paused) return;
    for (const listener of [...this.dataListeners]) listener(chunk);
  }

  /** Pushes output even while paused, which a real pty would not do. */
  emitThroughGate(chunk: Buffer | string): void {
    for (const listener of [...this.dataListeners]) listener(chunk);
  }

  exit(exitCode: number): void {
    if (this.finished) return;
    this.finished = true;
    for (const listener of [...this.exitListeners]) listener({ exitCode });
  }

  /** What the session wrote, as the bytes it meant. */
  written(): Buffer {
    return Buffer.concat(
      this.writes.map((text) => Buffer.from(text, "binary")),
    );
  }
}

/** A spawner that hands every session a {@link FakePty}, and remembers them. */
export function fakeSpawner(): {
  spawn: (options: SpawnOptions) => HostPty;
  opened: FakePty[];
  last(): FakePty;
} {
  const opened: FakePty[] = [];
  return {
    spawn: (options) => {
      const pty = new FakePty(options, 4000 + opened.length);
      opened.push(pty);
      return pty;
    },
    opened,
    last(): FakePty {
      const pty = opened.at(-1);
      if (pty === undefined) throw new Error("no console was opened");
      return pty;
    },
  };
}
