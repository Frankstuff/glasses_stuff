/** Stockfish: find it, download it if needed, and ask it for the best move over UCI. */

import { type ChildProcessWithoutNullStreams, execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, chmodSync, constants, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { createInterface } from "node:readline";

import { Chess } from "chess.js";

import { dataDir } from "./config.js";
import { gameOver } from "./game.js";

// Pinned official build: https://github.com/official-stockfish/Stockfish/releases/tag/sf_19
export const STOCKFISH_VERSION = "19";
export const STOCKFISH_URL =
  "https://github.com/official-stockfish/Stockfish/releases/download/sf_19/stockfish-macos-universal.tar.gz";
export const STOCKFISH_SHA256 = "a1f0e3bcc5a6927a11fe6fc8e54a779754645f3c2bae2cf13420fd1957adaa77";
const STOCKFISH_MEMBER = "stockfish/stockfish-macos-universal";

// Asset digests verified against the official sf_19 GitHub release, 2026-10-28.
const LINUX_BUILDS: Record<string, { name: string; sha256: string }> = {
  x64: { name: "stockfish-linux-x86-64-universal", sha256: "9defc0d4e55d49c65a6d042f3e571a39fcea499ade6dbe741b53b8c65e03611f" },
  arm64: { name: "stockfish-linux-arm64-universal", sha256: "fe26cfd1d9db4c8af3d21e24d9ff34cacb31c1f940085a7583da11796f2bac01" },
};

export function installedPath(): string {
  return join(dataDir(), "bin", "stockfish");
}

/** CHESSHACKER_STOCKFISH, then `stockfish` on PATH, then the copy setup downloaded. */
export function findStockfish(): string | null {
  const override = process.env.CHESSHACKER_STOCKFISH;
  if (override) return override;
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    const candidate = join(dir, "stockfish");
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // not in this directory
    }
  }
  return existsSync(installedPath()) ? installedPath() : null;
}

/**
 * Download the pinned official macOS build, verify its checksum, and install it.
 * `progress(bytesDone, bytesTotal)` is called as the download goes.
 */
export async function downloadStockfish(progress?: (done: number, total: number) => void): Promise<string> {
  const linux = process.platform === "linux" ? LINUX_BUILDS[process.arch] : undefined;
  if (process.platform !== "darwin" && !linux) throw new Error("Install Stockfish for your platform and set CHESSHACKER_STOCKFISH to its executable.");
  const url = linux ? `https://github.com/official-stockfish/Stockfish/releases/download/sf_19/${linux.name}.tar.gz` : STOCKFISH_URL;
  const expected = linux?.sha256 ?? STOCKFISH_SHA256;
  const member = linux ? `stockfish/${linux.name}` : STOCKFISH_MEMBER;
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok || !response.body) throw new Error(`Stockfish download failed: HTTP ${response.status}`);
  const total = Number(response.headers.get("content-length") ?? 0);
  const chunks: Uint8Array[] = [];
  let done = 0;
  for await (const chunk of response.body) {
    chunks.push(chunk);
    done += chunk.length;
    progress?.(done, total);
  }
  const archive = Buffer.concat(chunks);
  const digest = createHash("sha256").update(archive).digest("hex");
  if (digest !== expected) throw new Error(`Stockfish download failed its checksum (got ${digest}). Try again.`);

  const tmp = mkdtempSync(join(tmpdir(), "chesshacker-"));
  try {
    writeFileSync(join(tmp, "stockfish.tar.gz"), archive);
    execFileSync("tar", ["-xzf", join(tmp, "stockfish.tar.gz"), "-C", tmp, member]);
    const target = installedPath();
    mkdirSync(dirname(target), { recursive: true });
    const partial = `${target}.part`;
    writeFileSync(partial, readFileSync(join(tmp, member)));
    chmodSync(partial, 0o755);
    renameSync(partial, target);
    return target;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** An evaluation from White's side: centipawns, or moves to mate (negative: White gets mated). */
export interface Score {
  cp?: number;
  mate?: number;
}

export interface Suggestion {
  move: string; // UCI, like "e2e4"
  score: Score; // from White's side
}

/** `score` (from White's side) from `side`'s point of view. */
export function scoreFor(score: Score, side: "w" | "b"): Score {
  if (side === "w") return score;
  return score.mate !== undefined ? { mate: -score.mate } : { cp: -(score.cp ?? 0) };
}

/** The score in a UCI "info" line, from the side to move's point of view. */
export function parseScore(line: string): Score | null {
  const found = /\bscore (cp|mate) (-?\d+)/.exec(line);
  if (!found) return null;
  return found[1] === "cp" ? { cp: Number(found[2]) } : { mate: Number(found[2]) };
}

/** Stockfish quit or stopped answering (as opposed to being asked something it can't answer). */
export class EngineError extends Error {}

/** Lines from a stream, read one at a time, in order. */
class Lines {
  private waiting: ((line: string | null) => void) | null = null;
  private buffered: string[] = [];
  private closed = false;

  constructor(stream: NodeJS.ReadableStream) {
    const reader = createInterface({ input: stream });
    reader.on("line", (line) => {
      if (this.waiting) {
        const resolve = this.waiting;
        this.waiting = null;
        resolve(line);
      } else {
        this.buffered.push(line);
      }
    });
    reader.on("close", () => {
      this.closed = true;
      this.waiting?.(null);
    });
  }

  next(): Promise<string | null> {
    if (this.buffered.length) return Promise.resolve(this.buffered.shift()!);
    if (this.closed) return Promise.resolve(null);
    return new Promise((resolve) => (this.waiting = resolve));
  }

  /** Read until a line passes `done`; every line read is passed to `seen` first. */
  async until(done: (line: string) => boolean, timeoutMs: number, seen?: (line: string) => void): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const remaining = deadline - Date.now();
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<"timeout">((resolve) => (timer = setTimeout(() => resolve("timeout"), Math.max(0, remaining))));
      const line = await Promise.race([this.next(), timeout]);
      clearTimeout(timer);
      if (line === "timeout") throw new EngineError("Stockfish stopped answering.");
      if (line === null) throw new EngineError("Stockfish quit unexpectedly.");
      seen?.(line);
      if (done(line)) return line;
    }
  }
}

/** A running Stockfish process. Call close() when done. */
export class Engine {
  private constructor(
    private readonly process: ChildProcessWithoutNullStreams,
    private readonly lines: Lines,
    readonly name: string,
    readonly thinkMs: number,
  ) {}

  static async start(path: string | null = findStockfish(), thinkMs = 500): Promise<Engine> {
    if (path === null) throw new Error("Stockfish isn't installed. Run `npx chesshacker setup`.");
    if (!Number.isFinite(thinkMs) || thinkMs <= 0) throw new Error("Stockfish think time must be positive.");
    const child = spawn(path, [], { stdio: ["pipe", "pipe", "pipe"] });
    child.stderr.resume();
    child.stdin.on("error", () => undefined); // writing to a Stockfish that died: the read below reports it
    const started = new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    try {
    await started;
    const lines = new Lines(child.stdout);
    let name = "Stockfish";
    child.stdin.write("uci\n");
    await lines.until((line) => line === "uciok", 10_000, (line) => {
      if (line.startsWith("id name ")) name = line.slice("id name ".length);
    });
    child.stdin.write("isready\n");
    await lines.until((line) => line === "readyok", 10_000);
    return new Engine(child, lines, name, thinkMs);
    } catch (error) {
      child.kill("SIGKILL");
      throw error;
    }
  }

  async best(fen: string): Promise<Suggestion> {
    const board = new Chess(fen);
    if (gameOver(board)) throw new Error("The game is over; there is no move to suggest.");
    this.process.stdin.write(`position fen ${fen}\ngo movetime ${this.thinkMs}\n`);
    let score: Score = { cp: 0 };
    const last = await this.lines.until((line) => line.startsWith("bestmove "), this.thinkMs + 10_000, (line) => {
      if (line.startsWith("info ")) score = parseScore(line) ?? score;
    });
    return { move: last.split(" ")[1], score: scoreFor(score, board.turn()) };
  }

  close(): void {
    // Ctrl-C reaches Stockfish too, so it may already be gone: writing to it then would fail
    if (this.process.exitCode === null && this.process.signalCode === null && this.process.stdin.writable) {
      this.process.stdin.write("quit\n");
      this.process.stdin.end();
      const killer = setTimeout(() => this.process.kill("SIGKILL"), 1000);
      killer.unref();
      this.process.once("close", () => clearTimeout(killer));
    }
  }
}

/** What SteadyEngine needs from an engine. */
export interface EngineLike {
  best(fen: string): Promise<Suggestion>;
  close(): void;
}

/**
 * Stockfish that comes back: if the process quits or stops answering, a fresh one is started
 * and the position asked again, once. A process that timed out is never reused, since the
 * search it gave up on could still answer later and be taken for the next one.
 */
export class SteadyEngine implements EngineLike {
  private closed = false;

  private constructor(
    private engine: EngineLike,
    private readonly launch: () => Promise<EngineLike>,
  ) {}

  static async start(launch: () => Promise<EngineLike> = () => Engine.start()): Promise<SteadyEngine> {
    return new SteadyEngine(await launch(), launch);
  }

  async best(fen: string): Promise<Suggestion> {
    try {
      return await this.engine.best(fen);
    } catch (error) {
      if (this.closed || !(error instanceof EngineError)) throw error;
      this.engine.close();
      this.engine = await this.launch();
      return this.engine.best(fen);
    }
  }

  close(): void {
    this.closed = true;
    this.engine.close();
  }
}
