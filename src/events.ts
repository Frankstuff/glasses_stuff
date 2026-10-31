/** What happens in a game, as events: streamed to the command center and saved to disk. */

import { appendFileSync } from "node:fs";

export interface GameEvent {
  t?: number;
  kind: string;
  [key: string]: unknown;
}

type Listener = (event: GameEvent) => void;

/**
 * A small event bus.
 *
 * `emit()` records an event, appends it to `logPath`, and hands it to every listener. `publish()`
 * hands something to listeners without recording it (the game's state snapshot, which is rebuilt
 * on demand and would only bloat the log).
 */
export class Events {
  private readonly kept: GameEvent[] = [];
  private readonly listeners = new Set<Listener>();

  constructor(
    readonly logPath: string | null = null,
    readonly keep = 300,
  ) {}

  emit(kind: string, data: Record<string, unknown> = {}): GameEvent {
    const event: GameEvent = { t: Date.now() / 1000, kind, ...data };
    this.kept.push(event);
    if (this.kept.length > this.keep) this.kept.shift();
    if (this.logPath) appendFileSync(this.logPath, `${JSON.stringify(event)}\n`);
    this.send(event);
    return event;
  }

  publish(kind: string, data: Record<string, unknown> = {}): void {
    this.send({ kind, ...data });
  }

  /** Recent events, plus a listener for everything from now on. */
  subscribe(listener: Listener): { recent: GameEvent[]; unsubscribe: () => void } {
    this.listeners.add(listener);
    return { recent: [...this.kept], unsubscribe: () => this.listeners.delete(listener) };
  }

  recent(): GameEvent[] {
    return [...this.kept];
  }

  private send(event: GameEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}
