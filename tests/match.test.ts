import { readFileSync } from "node:fs";
import { Chess } from "chess.js";
import { describe, expect, it } from "vitest";
import { Grid, Tracker, match, type Reading } from "../src/match.js";

const reading = (grid: Grid): Reading => ({ grid, boardVisible: true, handOverBoard: false });

describe("legal move inference from occupancy", () => {
  it("follows all 33 Opera Game plies with two independent agreeing readings", () => {
    const truth = new Chess();
    truth.loadPgn(readFileSync(new URL("../fixtures/opera.pgn", import.meta.url), "utf8"));
    const tracker = new Tracker();
    for (const move of truth.history({ verbose: true })) {
      const observed = reading(Grid.of(move.after));
      expect(tracker.update(observed).kind).toBe("seen");
      const update = tracker.update(observed);
      expect(update.kind).toBe("committed");
      expect(update.san).toBe(move.san);
      expect(tracker.board.fen()).toBe(move.after);
    }
    expect(tracker.board.isCheckmate()).toBe(true);
  }, 60_000);
  it("never commits all-unknown observations or hands over the board", () => {
    const tracker = new Tracker();
    const board = new Chess(); board.move("e4");
    for (let i = 0; i < 8; i++) {
      expect(tracker.update(reading(Grid.unknown())).kind).toBe("waiting");
      expect(tracker.update({ ...reading(Grid.of(board.fen())), handOverBoard: true }).kind).toBe("skipped");
    }
    expect(tracker.board.history()).toEqual([]);
  });
  it("recognizes castling and en passant, using history rather than piece shapes", () => {
    for (const [fen, san] of [
      ["r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1", "O-O"],
      ["4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 1", "exd6"],
    ]) {
      const board = new Chess(fen); const tracker = new Tracker(board);
      const move = board.move(san); const observed = reading(Grid.of(board.fen()));
      tracker.update(observed);
      expect(tracker.update(observed).move?.lan).toBe(move.lan);
    }
  });
  it("documents the occupancy-only queen-promotion assumption", () => {
    const board = new Chess("7k/P7/8/8/8/8/8/7K w - - 0 1");
    const fen = board.fen(); board.move("a8=N");
    expect(match(fen, Grid.of(board.fen())).move?.promotion).toBe("q");
  });
  it("loses tracking after six loose fits without inventing a move", () => {
    const board = new Chess();
    for (const move of ["e4", "e5", "Nf3", "Nc6", "Bb5", "a6"]) board.move(move);
    const tracker = new Tracker();
    const kinds = Array.from({ length: 6 }, () => tracker.update(reading(Grid.of(board.fen()))).kind);
    expect(kinds).toEqual(["waiting", "waiting", "waiting", "waiting", "waiting", "lost"]);
    expect(tracker.board.history()).toEqual([]);
  });
  it("tracks a move and a reply that both happened between reads", () => {
    const board = new Chess(); board.move("e4"); board.move("e5");
    const tracker = new Tracker();
    const observed = reading(Grid.of(board.fen()));
    for (let i = 0; i < 8 && tracker.board.history().length < 2; i++) tracker.update(observed);
    expect(tracker.board.history()).toEqual(["e4", "e5"]);
  });
});
