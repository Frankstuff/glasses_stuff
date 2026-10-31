import { Chess } from "chess.js";
import { expect, it } from "vitest";
import { copyBoard, gameOver, moveFrom, movesText, spoken } from "../src/game.js";
import { scoreText } from "../src/main.js";
import { sayable, Speaker } from "../src/speak.js";

it("speaks piece names, captures, disambiguation and check", () => {
  const board = new Chess();
  expect(spoken(board.move("Nf3"))).toBe("Knight to f3");
  board.move("d5"); board.move("e4");
  expect(spoken(board.move("dxe4"))).toBe("Pawn d takes e4");
  const ambiguous = new Chess("7k/8/8/8/8/1N3N2/8/7K w - - 0 1");
  expect(spoken(ambiguous.move("Nbd2"))).toBe("Knight b to d2");
  expect(sayable("Rook a to a4")).toBe("Rook ay to ay 4");
});
it("copies move history and preserves claim-only draws", () => {
  const board = new Chess();
  for (let i = 0; i < 2; i++) for (const san of ["Nf3", "Nf6", "Ng1", "Ng8"]) board.move(san);
  expect(board.isThreefoldRepetition()).toBe(true);
  expect(gameOver(board)).toBeNull();
  expect(copyBoard(board).history()).toEqual(board.history());
  for (let i = 0; i < 2; i++) for (const san of ["Nf3", "Nf6", "Ng1", "Ng8"]) board.move(san);
  expect(gameOver(board)?.termination).toBe("fivefold_repetition");
});
it("formats scores and numbers from either side", () => {
  expect(scoreText({ cp: 150 }, "b")).toBe("-1.5");
  expect(scoreText({ mate: -3 }, "w")).toBe("mated in 3");
  expect(movesText("7k/8/8/8/8/8/8/K7 b - - 0 12", ["Kg6", "Kb2"])).toBe("12...Kg6 13. Kb2");
  expect(moveFrom(new Chess().fen(), "e2e5")).toBeNull();
});
it("clears queued speech when a position changes", async () => {
  const said: string[] = [];
  const speaker = new Speaker("none", { onSpoken: text => said.push(text) });
  speaker.say("old suggestion");
  speaker.clear();
  speaker.say("new suggestion");
  await speaker.wait();
  expect(said).toEqual(["new suggestion"]);
});
