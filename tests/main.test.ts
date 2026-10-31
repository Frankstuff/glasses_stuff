import { Chess } from "chess.js";
import { expect, it, vi } from "vitest";
import { DEFAULT_MODEL } from "../src/config.js";
import { Events } from "../src/events.js";
import { Game } from "../src/main.js";
import { Grid } from "../src/match.js";
import type { Answer } from "../src/vision.js";

function fixture() {
  const truth = new Chess();
  const speaker = { say: vi.fn(), clear: vi.fn() };
  const events = new Events();
  const answer: Answer = { data: {}, error: null, model: DEFAULT_MODEL, input_tokens: 0, output_tokens: 0, seconds: 0 };
  const vision = { model: DEFAULT_MODEL, strategy: "fixture", async ask() { return answer; }, reading() { return { grid: Grid.of(truth.fen()), boardVisible: true, handOverBoard: false }; } };
  const engine = { best: vi.fn(async (fen: string) => ({ move: new Chess(fen).moves({ verbose: true })[0].lan, score: { cp: 12 } })) };
  const game = new Game({ finished: false, async grab() { return null; } }, { vision, engine, speaker, events, myColor: "w", maxAdviceAge: 2 });
  return { truth, speaker, events, engine, game, vision };
}

it("clears previous suggestions on normal commits and suggests only on our turn", async () => {
  const { game, truth, engine, speaker } = fixture();
  await game.onFrame({ jpeg: Buffer.alloc(0), t: 0 });
  expect(engine.best).toHaveBeenCalledTimes(1);
  truth.move("e4");
  await game.onFrame({ jpeg: Buffer.alloc(0), t: 1 });
  await game.onFrame({ jpeg: Buffer.alloc(0), t: 2 });
  expect(speaker.clear).toHaveBeenCalled();
  expect(game.tracker.board.history()).toEqual(["e4"]);
  expect(game.suggestion).toBeNull();
  expect(engine.best).toHaveBeenCalledTimes(1);
});
it("suppresses advice from an old capture and retries after fresh confirmation", async () => {
  const { game, events } = fixture();
  await game.onFrame({ jpeg: Buffer.alloc(0), t: 0, capturedAt: Date.now() - 5000 });
  expect(events.recent().some(e => e.kind === "suggest")).toBe(false);
  expect(events.recent().some(e => e.kind === "stale")).toBe(true);
  await game.onFrame({ jpeg: Buffer.alloc(0), t: 1, capturedAt: Date.now() });
  expect(events.recent().some(e => e.kind === "suggest")).toBe(true);
});
it("a pause while Stockfish thinks prevents its suggestion from being spoken", async () => {
  const { game, engine, events } = fixture();
  let finish!: (value: { move: string; score: { cp: number } }) => void;
  engine.best.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const frame = game.onFrame({ jpeg: Buffer.alloc(0), t: 0 });
  await vi.waitFor(() => expect(engine.best).toHaveBeenCalled());
  game.control({ action: "pause" });
  finish({ move: "e2e4", score: { cp: 0 } });
  await frame;
  expect(events.recent().some(e => e.kind === "suggest")).toBe(false);
  await game.applyControls();
  expect(game.paused).toBe(true);
});
it("does not resume paid reads after the spend cap has been exceeded", async () => {
  const { game } = fixture();
  game.charge(11);
  game.control({ action: "resume" });
  await game.applyControls();
  expect(game.paused).toBe(true);
});

it("an unreadable fresh frame cannot renew expired advice", async () => {
  const { game, vision, events } = fixture();
  await game.onFrame({ jpeg: Buffer.alloc(0), t: 0, capturedAt: Date.now() - 5000 });
  vi.spyOn(vision, "reading").mockReturnValue({ grid: Grid.unknown(), boardVisible: false, handOverBoard: false });
  await game.onFrame({ jpeg: Buffer.alloc(0), t: 1, capturedAt: Date.now() });
  expect(events.recent().filter(e => e.kind === "suggest")).toHaveLength(0);
});

it("lost tracking clears advice and repeat cannot bring it back", async () => {
  const { game, truth, speaker } = fixture();
  await game.onFrame({ jpeg: Buffer.alloc(0), t: 0, capturedAt: Date.now() });
  for (const move of ["e4", "e5", "Nf3", "Nc6", "Bb5", "a6"]) truth.move(move);
  for (let t = 1; t <= 6; t++) await game.onFrame({ jpeg: Buffer.alloc(0), t, capturedAt: Date.now() });
  expect(game.tracker.lost).toBe(true);
  expect(game.suggestion).toBeNull();
  speaker.say.mockClear();
  game.control({ action: "repeat" }); await game.applyControls();
  expect(speaker.say).not.toHaveBeenCalled();
  expect(game.snapshot().suggestion).toBeNull();
});

it("repeat respects capture age", async () => {
  const { game, speaker } = fixture();
  const at = Date.now();
  await game.onFrame({ jpeg: Buffer.alloc(0), t: 0, capturedAt: at });
  const now = vi.spyOn(Date, "now").mockReturnValue(at + 3000);
  try {
    speaker.say.mockClear();
    game.control({ action: "repeat" }); await game.applyControls();
    expect(speaker.say).not.toHaveBeenCalled();
    expect(game.snapshot().suggestion).toBeNull();
  } finally { now.mockRestore(); }
});

it("accounts for a completed gate even if the following vision request throws", async () => {
  const { vision, engine, speaker, events } = fixture();
  vision.ask = async () => { throw new Error("vision rejected request"); };
  const gate = {
    async ask() { return { readable: 1, hand: 0, changed: 1, model: "jev-1.14.0", input_tokens: 1_000_000, seconds: 0, error: null }; },
    verdict() { return "ask_claude" as const; },
  };
  const game = new Game({ finished: false, async grab() { return null; } }, { vision, engine, speaker, events, gate, myColor: "w" });
  await expect(game.onFrame({ jpeg: Buffer.alloc(0), t: 0 })).rejects.toThrow("vision rejected");
  expect(game.spent).toBeCloseTo(0.042);
});

it("stops before the vision call when a gate alone exceeds the cap", async () => {
  const { vision, engine, speaker, events } = fixture();
  const ask = vi.spyOn(vision, "ask");
  const gate = {
    async ask() { return { readable: 1, hand: 0, changed: 1, model: "jev-1.14.0", input_tokens: 1_000_000, seconds: 0, error: null }; },
    verdict() { return "ask_claude" as const; },
  };
  const game = new Game({ finished: false, async grab() { return null; } }, { vision, engine, speaker, events, gate, myColor: "w", maxCost: 0.01 });
  await game.onFrame({ jpeg: Buffer.alloc(0), t: 0 });
  expect(game.paused).toBe(true);
  expect(ask).not.toHaveBeenCalled();
});

it("exits at decoder EOF while paused even if a final frame is buffered", async () => {
  const { vision, engine, speaker, events } = fixture();
  const game = new Game({ finished: false, ended: true, async grab() { throw new Error("must not grab while paused"); } },
    { vision, engine, speaker, events, myColor: "w", exitAtEnd: true });
  game.paused = true;
  const signal = AbortSignal.timeout(1000);
  await game.run(signal);
  expect(signal.aborted).toBe(false);
});

it("exits after checkmate when the decoder ends", async () => {
  const { vision, engine, speaker, events } = fixture();
  const board = new Chess("7k/6Q1/6K1/8/8/8/8/8 b - - 0 1");
  vision.reading = () => ({ grid: Grid.of(board.fen()), boardVisible: true, handOverBoard: false });
  let ended = false;
  const source = { finished: false, get ended() { return ended; }, async grab() { ended = true; return { jpeg: Buffer.alloc(0), t: 0 }; } };
  const game = new Game(source, { vision, engine, speaker, events, myColor: "b", start: board, exitAtEnd: true, pace: { mine: 0, opponent: 0 } });
  const signal = AbortSignal.timeout(2000);
  await game.run(signal);
  expect(signal.aborted).toBe(false);
  expect(events.recent().some(e => e.kind === "game_over")).toBe(true);
});

it("abort returns promptly even if a reader ignores cancellation", async () => {
  const { vision, engine, speaker, events } = fixture();
  const ask = vi.spyOn(vision, "ask").mockImplementation(() => new Promise(() => {}));
  const game = new Game({ finished: false, async grab() { return { jpeg: Buffer.alloc(0), t: 0 }; } }, { vision, engine, speaker, events, myColor: "w" });
  const stop = new AbortController();
  const running = game.run(stop.signal);
  await vi.waitFor(() => expect(ask).toHaveBeenCalled());
  stop.abort();
  await running;
  expect(engine.best).not.toHaveBeenCalled();
  expect(events.recent().some(e => e.kind === "error")).toBe(false);
});
