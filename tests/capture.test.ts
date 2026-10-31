import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ffmpegPath from "ffmpeg-static";
import sharp from "sharp";
import { expect, it, vi } from "vitest";
import { JpegSplitter, Replay, VideoFile, toJpeg } from "../src/capture.js";

it("splits JPEGs across arbitrary chunks and ignores leading stream noise", async () => {
  const jpeg = await sharp({ create: { width: 16, height: 16, channels: 3, background: "red" } }).jpeg().toBuffer();
  const input = Buffer.concat([Buffer.from("noise"), jpeg, jpeg]);
  const splitter = new JpegSplitter(); const output: Buffer[] = [];
  for (let i = 0; i < input.length; i += 7) output.push(...splitter.push(input.subarray(i, i + 7)));
  expect(output).toEqual([jpeg, jpeg]);
  expect((await sharp(await toJpeg(jpeg, 8)).metadata()).width).toBe(8);
});
it("samples an actual ffmpeg recording and reports invalid input", async () => {
  const dir = mkdtempSync(join(tmpdir(), "chesshacker-capture-"));
  try {
    const path = join(dir, "sample.mp4");
    execFileSync(ffmpegPath as unknown as string, ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=blue:s=64x64:r=10", "-t", "2", "-c:v", "libx264", path]);
    const frames = [];
    for await (const frame of new VideoFile(path, 0.5)) frames.push(frame);
    expect(frames.map(frame => frame.t)).toEqual([0, 0.5, 1, 1.5]);
    expect((await sharp(frames[0].jpeg).metadata()).width).toBe(64);
    await expect(Replay.open(join(dir, "missing.mp4"))).rejects.toThrow();
    await expect(async () => { for await (const _frame of new VideoFile(join(dir, "missing.mp4"))) { /* drain */ } }).rejects.toThrow();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it("offers the final decoded frame to tracking after EOF even when the overlay viewed it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "chesshacker-replay-"));
  let replay: Replay | undefined;
  try {
    const path = join(dir, "short.mp4");
    execFileSync(ffmpegPath as unknown as string, ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=blue:s=64x64:r=10", "-t", "0.3", "-c:v", "libx264", path]);
    replay = await Replay.open(path, 20);
    await vi.waitFor(() => expect(replay!.ended).toBe(true));
    expect(replay.finished).toBe(false);
    const overlayFrame = await replay.peek();
    expect(overlayFrame).not.toBeNull();
    expect(replay.finished).toBe(false);
    const trackingFrame = await replay.grab();
    expect(trackingFrame?.t).toBe(overlayFrame?.t);
    expect(trackingFrame?.jpeg).toEqual(overlayFrame?.jpeg);
    expect(replay.finished).toBe(true);
    expect(await replay.grab()).toBeNull();
    // An overlay can continue displaying the image without reviving tracking evidence.
    expect((await replay.peek())?.t).toBe(trackingFrame?.t);
    expect(replay.finished).toBe(true);
  } finally {
    replay?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

it("rejects an aborted image conversion before doing work", async () => {
  const signal = AbortSignal.abort(new Error("cancelled capture"));
  await expect(toJpeg(Buffer.from("not an image"), undefined, signal)).rejects.toThrow("cancelled capture");
});
