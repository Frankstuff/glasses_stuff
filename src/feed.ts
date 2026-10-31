/**
 * The overlay video, live: frames from the call (or a recording) with the overlay drawn on them.
 *
 * It only runs while someone is watching (the command center's /overlay page, an OBS Browser
 * Source, …) or it's being recorded or streamed with `--overlay-out`. Meanwhile the board
 * locator asks the vision model where the board is every few seconds; between answers the
 * overlay stays where the board last was.
 */

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

import ffmpegPath from "ffmpeg-static";

import type { Source } from "./capture.js";
import type { Corners } from "./geometry.js";
import type { Locator } from "./locate.js";
import { type OverlayState, renderOverlay } from "./overlay.js";
import { cost } from "./pricing.js";

/** What the feed needs from the game. */
export interface OverlayGame {
  overlayState(): Omit<OverlayState, "corners">;
  charge(dollars: number): void;
  overlayError(detail: string): void; // logged, not spoken: the overlay is for viewers, not the wearer
  readonly paused: boolean;
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

export interface FeedOptions {
  fps?: number;
  locateEvery?: number; // seconds between board locates (at most one at a time)
  out?: string | null; // a file (overlay.mp4) or a stream URL (rtmp://…, udp://…, tcp://…)
  speed?: number; // a recording's playback speed: the --overlay-out file plays at normal speed
}

export class OverlayFeed {
  readonly fps: number;
  readonly locateEvery: number;
  corners: Corners | null = null;
  private latest: Buffer | null = null;
  private readonly viewers = new Set<(jpeg: Buffer) => void>();
  private recorder: Recorder | null = null;

  constructor(
    readonly source: Source,
    readonly game: OverlayGame,
    readonly locator: Locator | null,
    readonly options: FeedOptions = {},
  ) {
    this.fps = options.fps ?? 10;
    this.locateEvery = options.locateEvery ?? 5;
  }

  /** Get each new overlay frame (JPEG) until the returned function is called. */
  subscribe(viewer: (jpeg: Buffer) => void): () => void {
    this.viewers.add(viewer);
    return () => this.viewers.delete(viewer);
  }

  get active(): boolean {
    return this.viewers.size > 0 || Boolean(this.options.out);
  }

  /** Runs until `signal` aborts. A failure in one frame or one locate is reported, never thrown. */
  async run(signal: AbortSignal): Promise<void> {
    // Either rendering completion or external cancellation must stop the locator too.
    const stop = new AbortController();
    const abort = () => stop.abort(signal.reason);
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
    const locating = this.locate(stop.signal);
    try {
      await this.render(stop.signal);
    } catch (error) {
      if (!stop.signal.aborted) this.game.overlayError(`drawing the overlay stopped: ${errorText(error)}`);
    } finally {
      stop.abort();
      signal.removeEventListener("abort", abort);
      await Promise.all([this.recorder?.close(), locating]);
    }
  }

  private async render(signal: AbortSignal): Promise<void> {
    let started = 0; // when recording started, to keep its frames in real time
    let written = 0;
    while (!signal.aborted) {
      if (this.source.finished) return;
      if (!this.active) {
        if (this.source.ended) return;
        await pause(250, signal);
        continue;
      }
      const tick = performance.now();
      try {
        const pending = this.source.peek ? this.source.peek(signal) : this.source.grab(signal);
        const frame = await untilAbort(pending, signal);
        if (signal.aborted) return;
        if (frame === null) {
          if (this.source.finished) return;
          await pause(500, signal);
          continue;
        }
        this.latest = frame.jpeg;
        const jpeg = await renderOverlay(frame.jpeg, { ...this.game.overlayState(), corners: this.corners });
        if (signal.aborted) return;
        for (const viewer of this.viewers) viewer(jpeg);
        if (this.options.out) {
          this.recorder ??= Recorder.start(this.options.out, this.fps / (this.options.speed ?? 1));
          if (!started) started = tick;
          // one frame per tick of real time: repeat this one if rendering fell behind
          const due = Math.floor(((performance.now() - started) / 1000) * this.fps) + 1;
          for (; written < due; written++) this.recorder.write(jpeg);
        }
        if (this.source.ended) return;
      } catch (error) {
        if (signal.aborted) return;
        this.game.overlayError(`drawing a frame: ${errorText(error)}`);
        await pause(1000, signal);
        continue;
      }
      await pause(Math.max(0, 1000 / this.fps - (performance.now() - tick)), signal);
    }
  }

  private async locate(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      if (this.source.ended ?? this.source.finished) return;
      if (!this.locator || !this.active || this.latest === null || this.game.paused) {
        await pause(500, signal);
        continue;
      }
      const started = performance.now();
      try {
        const { corners, answer } = await this.locator.locate({ jpeg: this.latest, t: 0 }, signal);
        this.game.charge(cost(answer.model, answer.input_tokens, answer.output_tokens, this.locator.vision.model));
        if (!signal.aborted && answer.error === null) this.corners = corners;
      } catch (error) {
        if (signal.aborted) return;
        this.game.overlayError(`finding the board: ${errorText(error)}`);
      }
      await pause(Math.max(0, this.locateEvery * 1000 - (performance.now() - started)), signal);
    }
  }
}

/** ffmpeg turning overlay frames into H.264, in a file or a live stream. */
export class Recorder {
  private constructor(private readonly process: ChildProcessWithoutNullStreams) {
    process.on("error", (error) => console.error(`ffmpeg couldn't start: ${error.message}`));
    process.stdin.on("error", () => undefined); // ffmpeg quit: its stderr says why
    process.stderr.on("data", (chunk: Buffer) => console.error(`ffmpeg: ${chunk.toString().trim()}`));
  }

  /** `fps` is the frame rate the video plays at: it can differ from the rate frames are written. */
  static start(out: string, fps: number): Recorder {
    const format = /^rtmps?:\/\//.test(out) ? ["-f", "flv"] : /^(udp|tcp):\/\//.test(out) ? ["-f", "mpegts"] : [];
    const args = [
      ...["-hide_banner", "-loglevel", "error", "-y", "-f", "image2pipe", "-framerate", String(fps), "-c:v", "mjpeg", "-i", "-"],
      ...["-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2", "-c:v", "libx264", "-preset", "veryfast", "-tune", "zerolatency"],
      ...["-pix_fmt", "yuv420p", "-g", String(Math.round(fps * 2)), ...format, out],
    ];
    return new Recorder(spawn(ffmpegPath as unknown as string, args));
  }

  write(jpeg: Buffer): void {
    if (this.process.stdin.writable && !this.process.stdin.writableNeedDrain) this.process.stdin.write(jpeg);
  }

  /** Finish the file (or stream) and wait for ffmpeg to exit. */
  async close(): Promise<void> {
    // already gone: exited, killed by a signal, or never started
    if (this.process.exitCode !== null || this.process.signalCode !== null || this.process.pid === undefined) return;
    const exited = new Promise((resolve) => this.process.once("close", resolve));
    this.process.stdin.end();
    const timeout = setTimeout(() => this.process.kill("SIGKILL"), 5000);
    timeout.unref();
    await exited;
    clearTimeout(timeout);
  }
}

/** Sleep, but wake up early (without throwing) when `signal` aborts. */
const pause = (ms: number, signal: AbortSignal) => sleep(ms, undefined, { signal }).catch(() => undefined);

/** Stop waiting even if an injected/native frame source cannot cancel its own work. */
function untilAbort<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
    pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
