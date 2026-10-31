/** Rebuilt evaluation tool. Synthetic tests measure tracking, not image recognition.
 * Recorded tests require a user-supplied video + PGN; no resync to ground truth is performed. */
import { createHash } from "node:crypto";
import { deepStrictEqual, strictEqual } from "node:assert";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Chess } from "chess.js";
import { Command, Option } from "commander";
import { VideoFile, type Frame } from "../src/capture.js";
import { visionModel } from "../src/config.js";
import { Grid, Tracker } from "../src/match.js";
import { cost, price } from "../src/pricing.js";
import { PROMPT_VERSION, makeVision, type Answer, type Vision, type Strategy } from "../src/vision.js";
import { Watcher, type Reader } from "../src/watch.js";

function positive(value: string): number {
  const number = Number(value);
  if (!(number > 0 && Number.isFinite(number))) throw new Error("Expected a positive number.");
  return number;
}

function loadGame(path: string): { start: Chess; expected: string[]; fens: string[] } {
  const board = new Chess(); board.loadPgn(readFileSync(path, "utf8"));
  const moves = board.history({ verbose: true });
  return { start: new Chess(moves[0]?.before ?? board.fen()), expected: moves.map(move => move.san), fens: moves.map(move => move.after) };
}

function report(expected: string[], actual: string[], details: Record<string, unknown>) {
  let prefix = 0;
  while (prefix < expected.length && actual[prefix] === expected[prefix]) prefix++;
  const exact = actual.length === expected.length && prefix === expected.length;
  console.log(JSON.stringify({ exact, expected, detected: actual, correct_prefix: prefix,
    missing_plies: Math.max(0, expected.length - actual.length), ...details }, null, 2));
  if (!exact) process.exitCode = 1;
}

function simulate(pgn: string): void {
  const { start, expected, fens } = loadGame(pgn);
  const tracker = new Tracker(start);
  let frames = 0;
  for (const fen of fens) {
    // A readable next position would be evidence unless the hand flag is respected.
    // Also test occlusion while one genuine confirming observation is pending.
    const before = tracker.board.history();
    const hidden = { grid: Grid.of(fen), boardVisible: true, handOverBoard: true };
    strictEqual(tracker.update(hidden).kind, "skipped"); frames++;
    deepStrictEqual(tracker.board.history(), before);
    tracker.update({ ...hidden, handOverBoard: false }); frames++;
    strictEqual(tracker.update(hidden).kind, "skipped"); frames++;
    deepStrictEqual(tracker.board.history(), before);
    for (let i = 0; i < 2; i++) {
      tracker.update({ grid: Grid.of(fen), boardVisible: true, handOverBoard: false }); frames++;
    }
  }
  report(expected, tracker.board.history(), { mode: "synthetic occupancy; no vision or API calls", frames, spent: 0 });
}

interface Options { simulate: boolean; pgn?: string; color: "white" | "black"; model: string; strategy: Strategy; every: number; maxCost: number; cache: string }

async function recording(video: string, options: Options): Promise<void> {
  if (!options.pgn) throw new Error("Recorded evaluation requires --pgn FILE with the actual game.");
  if (!existsSync(video)) throw new Error(`No such video: ${video}`);
  if (!price(options.model)) throw new Error(`No verified pricing for ${options.model}.`);
  const { start, expected } = loadGame(options.pgn);
  const tracker = new Tracker(start);
  let spent = 0, cached = 0, paid = 0, frames = 0;
  const latencies: number[] = [];
  mkdirSync(options.cache, { recursive: true });
  const wrap = (vision: Vision): Reader => ({
    async ask(frame: Frame, fen: string, reference: Frame | null) {
      const hash = createHash("sha256").update(JSON.stringify({ version: PROMPT_VERSION, model: vision.model, strategy: vision.strategy, system: vision.system, fen })).update(frame.jpeg).update(reference?.jpeg ?? Buffer.alloc(0)).digest("hex");
      const path = join(options.cache, `${hash}.json`);
      if (existsSync(path)) {
        cached++;
        return JSON.parse(readFileSync(path, "utf8")) as Answer;
      }
      if (spent >= options.maxCost) throw new Error("Evaluation spending cap reached.");
      const answer = await vision.ask(frame, fen, reference);
      spent += cost(answer.model, answer.input_tokens, answer.output_tokens, vision.model);
      paid++; latencies.push(answer.seconds);
      if (!answer.error && answer.data) writeFileSync(path, JSON.stringify(answer));
      return answer;
    },
    reading: (answer, fen) => vision.reading(answer, fen),
  });
  const color = options.color === "white" ? "w" : "b";
  const watcher = new Watcher(tracker,
    wrap(makeVision(options.model, { strategy: options.strategy, myColor: color })), null, 3,
    options.strategy === "changes" ? wrap(makeVision(options.model, { strategy: "occupancy", myColor: color })) : null);
  for await (const frame of new VideoFile(video, options.every)) {
    const step = await watcher.step(frame); frames++;
    if (step.update.san) console.error(`${frame.t.toFixed(1)}s: ${step.update.san}`);
    if (step.answer?.error) console.error(`Frame ${frame.t}: ${step.answer.error}`);
    if (spent >= options.maxCost) break;
  }
  latencies.sort((a, b) => a - b);
  report(expected, tracker.board.history(), { mode: "recorded video; no ground-truth resync", frames, spent, paid_reads: paid, cached_reads: cached,
    median_api_seconds: latencies.length ? latencies[Math.floor(latencies.length / 2)] : null,
    note: "PGN has no move timestamps: capture-to-speech latency is not measured here." });
}

await new Command().argument("[video]").option("--simulate", "free synthetic matcher evaluation", false)
  .option("--pgn <file>", "known game (defaults to Opera Game for simulation)")
  .addOption(new Option("--color <color>", "wearer's perspective").choices(["white", "black"]).default("white"))
  .option("--model <model>", "vision model", visionModel())
  .addOption(new Option("--strategy <strategy>", "vision strategy").choices(["occupancy", "changes", "pick"]).default("changes"))
  .option("--every <seconds>", "sample interval", positive, 1)
  .option("--max-cost <dollars>", "stop at estimated spend (one request may overshoot)", positive, 1)
  .option("--cache <directory>", "cache successful model answers", "evals/.cache")
  .action(async (video: string | undefined, options: Options) => {
    if (options.simulate) simulate(options.pgn ?? new URL("../fixtures/opera.pgn", import.meta.url).pathname);
    else if (video) await recording(video, options);
    else throw new Error("Use --simulate, or provide VIDEO --pgn FILE.");
  }).parseAsync().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
