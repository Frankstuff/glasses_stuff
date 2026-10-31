import { expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  start: vi.fn(),
  close: vi.fn(),
  serve: vi.fn(),
  dataDir: vi.fn(),
  readFileSync: vi.fn(),
}));
vi.mock("../src/engine.js", async (original) => ({
  ...await original<typeof import("../src/engine.js")>(),
  SteadyEngine: { start: mocks.start },
}));
vi.mock("../src/web.js", () => ({ serve: mocks.serve }));
vi.mock("../src/config.js", async (original) => ({
  ...await original<typeof import("../src/config.js")>(),
  dataDir: mocks.dataDir,
}));
vi.mock("node:fs", async (original) => ({
  ...await original<typeof import("node:fs")>(),
  readFileSync: mocks.readFileSync,
}));

import { ScriptedSource, demo } from "../src/demo.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

it("rejects a different move sequence even when its length matches the demonstration", () => {
  const source = new ScriptedSource("1. e4 e5 2. Nf3 Nc6 *");
  expect(source.matches(["e4", "e5", "Nf3", "Nc6"])).toBe(true);
  expect(source.matches(["d4", "d5", "Nf3", "Nc6"])).toBe(false);
  expect(source.matches(["e4", "e5"])).toBe(false);
});

it("does not launch Stockfish if the runtime fixture is missing", async () => {
  mocks.start.mockClear();
  mocks.readFileSync.mockImplementation(() => { throw new Error("missing fixture"); });
  await expect(demo({ browser: false, every: 0.01 })).rejects.toThrow("missing fixture");
  expect(mocks.start).not.toHaveBeenCalled();
});

it("closes an acquired engine when command-center startup fails", async () => {
  const dir = mkdtempSync(join(tmpdir(), "chesshacker-demo-"));
  mocks.readFileSync.mockReturnValue("1. e4 e5 *");
  mocks.dataDir.mockReturnValue(dir);
  mocks.close.mockClear();
  mocks.start.mockResolvedValue({ best: vi.fn(), close: mocks.close });
  mocks.serve.mockRejectedValue(new Error("port unavailable"));
  const before = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
  try {
    await expect(demo({ browser: false, every: 0.01 })).rejects.toThrow("port unavailable");
    expect(mocks.close).toHaveBeenCalledOnce();
    expect([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")]).toEqual(before);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
