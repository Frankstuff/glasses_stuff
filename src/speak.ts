/** Say things into the call: macOS `say`, played on BlackHole, which WhatsApp uses as its mic. */

import { spawn } from "node:child_process";

export const BLACKHOLE = "BlackHole 2ch";
export type Target = "call" | "speakers" | "none";
export const TARGETS: Target[] = ["call", "speakers", "none"];

/** Runs a command and resolves to whether it worked. */
export type Runner = (command: string[]) => Promise<boolean>;

const SAY_TIMEOUT_MS = 20_000; // a line takes 1–3 s; a stuck `say` mustn't hold up the rest

export const runCommand: Runner = (command) =>
  new Promise((resolve) => {
    const child = spawn(command[0], command.slice(1), { stdio: "ignore", timeout: SAY_TIMEOUT_MS });
    child.on("close", (code) => resolve(code === 0));
    child.on("error", () => resolve(false));
  });

/**
 * The text as `say` should get it. On its own, "a" is read as the word "uh", so the a-file in
 * "Rook a to d1" or "Pawn to a4" is spelled out as a letter. ("It's a draw" is left alone.)
 */
export function sayable(text: string): string {
  return text.replace(/\ba(?=[1-8]\b)/g, "ay ").replace(/\ba(?= (?:to|takes)\b)/g, "ay");
}

export interface SpeakerOptions {
  device?: string;
  rate?: number;
  onSpoken?: (text: string) => void;
  onFailed?: (text: string) => void;
  run?: Runner;
}

/**
 * Speaks one line at a time, in order, without blocking the caller.
 *
 * `target` is where speech goes: "call" (BlackHole, into the WhatsApp call), "speakers" (this
 * Mac, for testing), or "none" (just report it). A line is reported as spoken only if `say`
 * worked; otherwise `onFailed` hears about it.
 */
export class Speaker {
  readonly device: string;
  readonly rate?: number;
  private readonly onSpoken?: (text: string) => void;
  private readonly onFailed?: (text: string) => void;
  private readonly run: Runner;
  private queue: Promise<void> = Promise.resolve();
  private generation = 0;

  constructor(
    readonly target: Target = "call",
    { device = BLACKHOLE, rate, onSpoken, onFailed, run = runCommand }: SpeakerOptions = {},
  ) {
    this.device = device;
    this.rate = rate;
    this.onSpoken = onSpoken;
    this.onFailed = onFailed;
    this.run = run;
  }

  say(text: string): void {
    const generation = this.generation;
    this.queue = this.queue
      .then(() => (generation === this.generation ? this.speak(text) : undefined))
      .catch(() => undefined);
  }

  /** Drop lines queued but not yet started, e.g. a suggestion for a position just undone. */
  clear(): void {
    this.generation++;
  }

  /** Resolves once everything queued has been said. */
  wait(): Promise<void> {
    return this.queue;
  }

  command(text: string): string[] | null {
    if (this.target === "none") return null;
    const command = ["say"];
    if (this.target === "call") command.push("-a", this.device);
    if (this.rate) command.push("-r", String(this.rate));
    return [...command, sayable(text)];
  }

  private async speak(text: string): Promise<void> {
    const command = this.command(text);
    const ok = command ? await this.run(command) : true;
    if (ok) this.onSpoken?.(text);
    else this.onFailed?.(text);
  }
}
