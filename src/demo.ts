/** New offline demo: scripted observations exercise the real tracker, engine and UI.
 * The observations are generated from a PGN, NOT inferred from the rendered JPEGs. */
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Chess } from "chess.js";
import sharp from "sharp";
import { boardSvg } from "./board-svg.js";
import type { Frame, Source } from "./capture.js";
import { dataDir, DEFAULT_MODEL } from "./config.js";
import { SteadyEngine } from "./engine.js";
import { Events } from "./events.js";
import { Game } from "./main.js";
import { Grid } from "./match.js";
import { Speaker } from "./speak.js";
import type { Answer } from "./vision.js";
import { serve } from "./web.js";

export class ScriptedSource implements Source {
  private index = 0;
  readonly positions: string[];
  readonly moves: string[];
  readonly readings = new Map<number, Grid>();
  constructor(pgn: string, readonly repeats = 3) {
    if (!Number.isInteger(repeats) || repeats <= 0) throw new Error("Demo frame repeats must be a positive integer.");
    const board = new Chess();
    board.loadPgn(pgn);
    const history = board.history({ verbose: true });
    this.moves = history.map(move => move.san);
    this.positions = [history[0]?.before ?? board.fen(), ...history.map(move => move.after)];
  }
  get finished(): boolean { return this.index >= this.positions.length * this.repeats; }
  async grab(signal?: AbortSignal): Promise<Frame | null> {
    signal?.throwIfAborted();
    if (this.finished) return null;
    const t = this.index++;
    const fen = this.positions[Math.floor(t / this.repeats)];
    const jpeg = await sharp(Buffer.from(boardSvg(fen))).jpeg().toBuffer();
    signal?.throwIfAborted();
    this.readings.set(t, Grid.of(fen));
    return { jpeg, t, capturedAt: Date.now() };
  }

  matches(moves: readonly string[]): boolean {
    return moves.length === this.moves.length && moves.every((move, i) => move === this.moves[i]);
  }
}

export function scriptedReader(source: ScriptedSource) {
  return {
    model: DEFAULT_MODEL, strategy: "scripted occupancy (no AI)",
    async ask(frame: Frame): Promise<Answer> {
      return { data: { t: frame.t }, error: null, model: DEFAULT_MODEL, input_tokens: 0, output_tokens: 0, seconds: 0 };
    },
    reading(answer: Answer) {
      return { boardVisible: true, handOverBoard: false, grid: source.readings.get(Number(answer.data?.t)) ?? null };
    },
  };
}

export async function demo(options: { browser: boolean; exitAtEnd?: boolean; every: number }): Promise<number> {
  // Validate fixtures and create the run directory before acquiring a child process.
  const source = new ScriptedSource(readFileSync(new URL("../fixtures/practice.pgn", import.meta.url), "utf8"));
  const runDir = join(dataDir(), "runs", `demo-${Date.now()}`);
  mkdirSync(runDir, { recursive: true });
  const events = new Events(join(runDir, "events.jsonl"));
  const speaker = new Speaker("none", { onSpoken: text => events.emit("spoken", { detail: text }) });
  const stop = new AbortController();
  const stopping = () => stop.abort();
  let closeServer = () => {};
  const engine = await SteadyEngine.start();
  try {
    const game = new Game(source, {
      vision: scriptedReader(source), engine, speaker, events, myColor: "w", runDir,
      pace: { opponent: options.every, mine: options.every }, exitAtEnd: options.exitAtEnd,
    });
    process.once("SIGINT", stopping);
    process.once("SIGTERM", stopping);
    const { server, url } = await serve(game);
    closeServer = () => { server.closeAllConnections(); server.close(); };
    console.log(`Offline demo: scripted occupancy, real Stockfish, no API calls.\nCommand center: ${url}\nLogs: ${runDir}`);
    if (options.browser && process.platform === "darwin") spawn("open", [url], { stdio: "ignore" }).on("error", () => undefined);
    await game.run(stop.signal);
    await speaker.wait();
    const moves = game.tracker.board.history();
    console.log(`Tracked ${moves.length} plies: ${moves.join(" ")}`);
    return options.exitAtEnd && !source.matches(moves) ? 1 : 0;
  } finally {
    closeServer();
    engine.close();
    process.off("SIGINT", stopping);
    process.off("SIGTERM", stopping);
  }
}
