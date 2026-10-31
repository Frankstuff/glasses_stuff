import { Chess } from "chess.js";
import { expect, it } from "vitest";
import { Grid, Tracker } from "../src/match.js";
import { Watcher, type Reader } from "../src/watch.js";
import type { Answer } from "../src/vision.js";

const frame = (t: number) => ({ jpeg: Buffer.from("synthetic fixture"), t });
const answer: Answer = { data: {}, error: null, model: "fixture", input_tokens: 0, output_tokens: 0, seconds: 0 };
const reader = (fen: string): Reader => ({ async ask() { return answer; }, reading() { return { grid: Grid.of(fen), boardVisible: true, handOverBoard: false }; } });

it("doesn't count the same source frame twice as confirmation", async () => {
  const board = new Chess(); board.move("e4");
  const tracker = new Tracker(); const watcher = new Watcher(tracker, reader(board.fen()));
  expect((await watcher.step(frame(1))).update.kind).toBe("seen");
  expect((await watcher.step(frame(1))).update.kind).toBe("skipped");
  expect((await watcher.step(frame(2))).update.kind).toBe("committed");
});
it("discards a model response invalidated by a manual control", async () => {
  const board = new Chess(); board.move("e4");
  let finish!: (a: Answer) => void;
  const delayed = reader(board.fen());
  delayed.ask = () => new Promise(resolve => { finish = resolve; });
  const tracker = new Tracker(undefined, { confirm: 1, evidence: 1 });
  const watcher = new Watcher(tracker, delayed);
  const step = watcher.step(frame(1));
  watcher.forget(); finish(answer);
  expect((await step).update.kind).toBe("skipped");
  expect(tracker.board.history()).toEqual([]);
});
it("audits silent changes with a full occupancy read", async () => {
  const board = new Chess(); const start = board.fen(); board.move("e4");
  const tracker = new Tracker();
  const watcher = new Watcher(tracker, reader(start), null, 3, reader(board.fen()), 2);
  watcher.confirm(frame(0));
  await watcher.step(frame(1)); await watcher.step(frame(2));
  expect((await watcher.step(frame(3))).update.kind).toBe("seen");
});
it("describes a reference that already includes the opponent's reply correctly", async () => {
  const board = new Chess(); board.move("e4"); board.move("e5");
  const tracker = new Tracker(); const watcher = new Watcher(tracker, reader(board.fen()));
  for (let t = 0; t < 8 && tracker.board.history().length === 0; t++) await watcher.step(frame(t));
  expect(tracker.board.history()).toEqual(["e4"]);
  expect(watcher.referenceFen).toBe(board.fen());
});
