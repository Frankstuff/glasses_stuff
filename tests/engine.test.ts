import { Chess } from "chess.js";
import { describe, expect, it, vi } from "vitest";
import { Engine, EngineError, SteadyEngine, findStockfish, parseScore, scoreFor } from "../src/engine.js";

it("parses UCI scores and normalizes them to White", () => {
  expect(parseScore("info depth 12 score cp -46 nodes 1200")).toEqual({ cp: -46 });
  expect(scoreFor({ mate: 3 }, "b")).toEqual({ mate: -3 });
});
it("restarts a dead engine once without reusing its pending response", async () => {
  const first = { best: vi.fn().mockRejectedValue(new EngineError("died")), close: vi.fn() };
  const second = { best: vi.fn().mockResolvedValue({ move: "e2e4", score: { cp: 35 } }), close: vi.fn() };
  const launch = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
  const engine = await SteadyEngine.start(launch);
  expect((await engine.best(new Chess().fen())).move).toBe("e2e4");
  expect(first.close).toHaveBeenCalled();
  expect(launch).toHaveBeenCalledTimes(2);
  engine.close();
});
describe.skipIf(!findStockfish())("real Stockfish integration", () => {
  it("returns legal opening advice and finds a mate in one", async () => {
    const engine = await Engine.start(undefined, 100);
    try {
      const opening = new Chess();
      const suggestion = await engine.best(opening.fen());
      expect(opening.move(suggestion.move)).toBeTruthy();
      const mate = new Chess("7k/5Q2/6K1/8/8/8/8/8 w - - 0 1");
      const winning = await engine.best(mate.fen());
      mate.move(winning.move);
      expect(mate.isCheckmate()).toBe(true);
      expect(winning.score.mate).toBe(1);
    } finally { engine.close(); }
  });
});
