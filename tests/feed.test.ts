import { Chess } from "chess.js";
import sharp from "sharp";
import { expect, it, vi } from "vitest";
import type { Source } from "../src/capture.js";
import { OverlayFeed, type OverlayGame } from "../src/feed.js";
import { Locator } from "../src/locate.js";
import type { Answer } from "../src/vision.js";

function game(): OverlayGame {
  return {
    paused: false,
    overlayState: () => ({ fen: new Chess().fen(), myColor: "w", suggestion: null, status: "Your move" }),
    charge: vi.fn(), overlayError: vi.fn(),
  };
}

it("aborts an active locator and stops scheduling calls without logging cancellation as failure", async () => {
  const jpeg = await sharp({ create: { width: 128, height: 128, channels: 3, background: "white" } }).jpeg().toBuffer();
  const source: Source = { finished: false, grab: vi.fn(async () => ({ jpeg, t: 0 })) };
  const center = game();
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  let requestSignal: AbortSignal | undefined;
  const send = vi.fn((_parts, _schema, signal?: AbortSignal) => new Promise<Answer>((_resolve, reject) => {
    requestSignal = signal;
    if (!signal) return reject(new Error("missing signal"));
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    entered();
  }));
  const feed = new OverlayFeed(source, center, new Locator({ model: "gpt-6.1-sol", send }), { fps: 20, locateEvery: 0.01 });
  feed.subscribe(() => {});
  const stop = new AbortController();
  const running = feed.run(stop.signal);
  await started;
  stop.abort();
  await running;
  expect(requestSignal?.aborted).toBe(true);
  expect(send).toHaveBeenCalledOnce();
  expect(center.overlayError).not.toHaveBeenCalled();
});

it("finishes both loops at source EOF even if nobody is watching", async () => {
  const source: Source = { finished: true, grab: vi.fn(async () => null) };
  const center = game();
  await new OverlayFeed(source, center, null).run(new AbortController().signal);
  expect(source.grab).not.toHaveBeenCalled();
  expect(center.overlayError).not.toHaveBeenCalled();
});

it("renders the buffered final image through peek without consuming the game's frame", async () => {
  const jpeg = await sharp({ create: { width: 128, height: 128, channels: 3, background: "white" } }).jpeg().toBuffer();
  const source: Source = { ended: true, finished: false, grab: vi.fn(async () => null), peek: vi.fn(async () => ({ jpeg, t: 1 })) };
  const center = game();
  const feed = new OverlayFeed(source, center, null);
  const viewer = vi.fn();
  feed.subscribe(viewer);
  await feed.run(new AbortController().signal);
  expect(source.peek).toHaveBeenCalledOnce();
  expect(source.grab).not.toHaveBeenCalled();
  expect(viewer).toHaveBeenCalledOnce();
  expect(source.finished).toBe(false);
});

it("stops waiting on a frame source that cannot cancel its work", async () => {
  const source: Source = { finished: false, grab: vi.fn(() => new Promise<never>(() => {})) };
  const center = game();
  const feed = new OverlayFeed(source, center, null);
  feed.subscribe(() => {});
  const stop = new AbortController();
  const running = feed.run(stop.signal);
  await vi.waitFor(() => expect(source.grab).toHaveBeenCalledOnce());
  stop.abort();
  await running;
  expect(center.overlayError).not.toHaveBeenCalled();
});
