/**
 * Turn what the vision model saw into chess moves.
 *
 * The model only reports which squares look occupied, and by which color. Code compares that
 * with the position after every legal move, and commits a move once enough frames in a row show
 * it fitting better than everything else.
 */

import { Chess, type Move } from "chess.js";

import { BLACK, EMPTY, WHITE, copyBoard, occupancy, squareIndex } from "./game.js";

export const UNKNOWN = -1;
export const REPLY_COST = 1; // a move that only fits if a reply was also made needs that much more evidence

const CHARS: Record<string, number> = { w: WHITE, b: BLACK, ".": EMPTY, "?": UNKNOWN };
const SYMBOLS: Record<number, string> = { [WHITE]: "w", [BLACK]: "b", [EMPTY]: ".", [UNKNOWN]: "?" };

export type Side = "w" | "b";

/** What each square was seen holding: a white piece, a black piece, nothing, or unknown. */
export class Grid {
  private constructor(private readonly cells: Int8Array) {}

  static of(fen: string): Grid {
    return new Grid(Int8Array.from(occupancy(fen)));
  }

  static unknown(): Grid {
    return new Grid(new Int8Array(64).fill(UNKNOWN));
  }

  /** Rows from rank 8 down to rank 1, each 8 characters for files a to h: w, b, . or ?. */
  static fromRows(rows: readonly string[]): Grid {
    if (rows.length !== 8 || rows.some((row) => row.length !== 8)) {
      throw new Error(`expected 8 rows of 8 squares, got ${JSON.stringify(rows)}`);
    }
    const cells = new Int8Array(64);
    rows.forEach((row, i) => {
      [...row].forEach((char, file) => {
        if (!(char in CHARS)) throw new Error(`unexpected ${JSON.stringify(char)} in row ${row}`);
        cells[file + 8 * (7 - i)] = CHARS[char];
      });
    });
    return new Grid(cells);
  }

  /** A copy with `square` seen as holding `side`'s piece, or empty when `side` is null. */
  set(square: string | number, side: Side | null): Grid {
    const cells = Int8Array.from(this.cells);
    const index = typeof square === "number" ? square : squareIndex(square);
    cells[index] = side === "w" ? WHITE : side === "b" ? BLACK : EMPTY;
    return new Grid(cells);
  }

  rows(): string[] {
    const rows: string[] = [];
    for (let rank = 7; rank >= 0; rank--) {
      let row = "";
      for (let file = 0; file < 8; file++) row += SYMBOLS[this.cells[file + 8 * rank]];
      rows.push(row);
    }
    return rows;
  }

  get known(): number {
    return this.cells.reduce((count, cell) => count + (cell === UNKNOWN ? 0 : 1), 0);
  }

  /** How many seen squares disagree with a position's occupancy. */
  mismatches(position: Uint8Array): number {
    let count = 0;
    for (let i = 0; i < 64; i++) {
      if (this.cells[i] !== UNKNOWN && this.cells[i] !== position[i]) count++;
    }
    return count;
  }

  equals(other: Grid): boolean {
    return this.cells.every((cell, i) => cell === other.cells[i]);
  }
}

export interface Candidate {
  move: Move | null; // null means "nothing has moved"
  score: number; // squares that disagree with what was seen, plus REPLY_COST if it needed a reply
  reply: Move | null; // the reply that made `move` fit best, if it needed one
}

export interface Match {
  kind: "no_change" | "move" | "tie" | "no_match";
  move: Move | null;
  margin: number; // how many squares better the best fit is than the runner-up
  ranked: Candidate[]; // best few, for logging
}

/**
 * Every legal move, plus "nothing moved", best fit first.
 *
 * With `lookahead`, a move is also scored together with each reply to it, at REPLY_COST, so a
 * reply made before the move was confirmed (say, a recapture on the same square) doesn't hide
 * it. Only the move itself is ever committed; the reply has to be confirmed on its own.
 *
 * Promotions to different pieces leave the same squares occupied, so they count once, as a
 * queen.
 */
export function rank(fen: string, grid: Grid, lookahead = true): Candidate[] {
  const board = new Chess(fen);
  const byOccupancy = new Map<string, Candidate>();
  for (const move of board.moves({ verbose: true })) {
    const after = occupancy(move.after);
    let best: Candidate = { move, score: grid.mismatches(after), reply: null };
    if (lookahead) {
      board.move(move.lan);
      for (const reply of board.moves({ verbose: true })) {
        const score = grid.mismatches(occupancy(reply.after)) + REPLY_COST;
        if (score < best.score) best = { move, score, reply };
      }
      board.undo();
    }
    const key = after.join("");
    if (!byOccupancy.has(key) || move.promotion === "q") byOccupancy.set(key, best);
  }
  const ranked = [{ move: null, score: grid.mismatches(occupancy(fen)), reply: null }, ...byOccupancy.values()];
  return ranked.sort((a, b) => a.score - b.score); // stable, so "nothing moved" wins ties
}

/**
 * What happened since `fen`, judging by `grid`.
 *
 * "no_match" when even the best fit disagrees with more than `maxMismatchRate` of the squares
 * the model could read (and more than 4): the tracked position, or the reading, is wrong.
 */
export function match(
  fen: string,
  grid: Grid,
  { lookahead = true, maxMismatchRate = 0.15 }: { lookahead?: boolean; maxMismatchRate?: number } = {},
): Match {
  const ranked = rank(fen, grid, lookahead);
  const best = ranked[0];
  const top = ranked.slice(0, 3);
  if (best.score > Math.max(4, roundHalfEven(maxMismatchRate * grid.known))) {
    return { kind: "no_match", move: null, margin: 0, ranked: top };
  }
  const margin = ranked.length > 1 ? ranked[1].score - best.score : grid.known;
  if (margin === 0) return { kind: "tie", move: null, margin: 0, ranked: top };
  if (best.move === null) return { kind: "no_change", move: null, margin, ranked: top };
  return { kind: "move", move: best.move, margin, ranked: top };
}

/** Python's round(): halves go to the even neighbour, so 4.5 -> 4 and 5.5 -> 6. */
export function roundHalfEven(x: number): number {
  const floor = Math.floor(x);
  const diff = x - floor;
  if (diff < 0.5) return floor;
  if (diff > 0.5) return floor + 1;
  return floor % 2 === 0 ? floor : floor + 1;
}

/** One frame, as the model described it. `grid` is null when the answer couldn't be used. */
export interface Reading {
  boardVisible: boolean;
  handOverBoard: boolean;
  grid: Grid | null;
}

export interface Update {
  kind: "skipped" | "waiting" | "seen" | "committed" | "lost";
  move: Move | null;
  san: string | null; // SAN of a committed move
  match: Match | null;
}

export const skipped: Update = { kind: "skipped", move: null, san: null, match: null };

export interface TrackerOptions {
  confirm?: number;
  evidence?: number;
  lostAfter?: number;
  maxMismatchRate?: number;
  maxOff?: number;
}

/**
 * Follows the game from frame readings, one move at a time.
 *
 * Each usable frame is evidence for its best-fitting move: how many squares better it fits than
 * the runner-up. A move is committed once it has been the best fit on at least `confirm` frames
 * in a row, adding up to at least `evidence` squares. Two clear frames are enough; murkier ones
 * take longer. A tie, a hand over the board, or looking away pauses the count; a different best
 * fit restarts it.
 *
 * A frame whose best fit is still more than `maxOff` squares off fits nothing: it can't confirm
 * a move (a loose fit is how a tracker that fell behind commits the wrong one). If nothing fits
 * for `lostAfter` usable frames in a row, the tracker is lost: the position it holds no longer
 * matches the board.
 */
export class Tracker {
  readonly confirm: number;
  readonly evidence: number;
  readonly lostAfter: number;
  readonly maxMismatchRate: number;
  readonly maxOff: number;
  board!: Chess;
  lost = false;
  private candidate: string | null = null; // the move being confirmed, as UCI
  private frames = 0;
  private gathered = 0;
  private misses = 0;

  constructor(
    board?: Chess,
    { confirm = 2, evidence = 3, lostAfter = 6, maxMismatchRate = 0.15, maxOff = 5 }: TrackerOptions = {},
  ) {
    this.confirm = confirm;
    this.evidence = evidence;
    this.lostAfter = lostAfter;
    this.maxMismatchRate = maxMismatchRate;
    this.maxOff = maxOff;
    this.reset(board ?? new Chess());
  }

  /** Whether a move has been seen and is waiting for more evidence. */
  get confirming(): boolean {
    return this.candidate !== null;
  }

  /** Follow the game from `board` (a copy is kept), e.g. after a mistake is fixed by hand. */
  reset(board: Chess): void {
    this.board = copyBoard(board);
    this.lost = false;
    this.misses = 0;
    this.restart(null);
  }

  update(reading: Reading): Update {
    if (reading.grid === null || !reading.boardVisible || reading.handOverBoard) return skipped;

    const found = match(this.board.fen(), reading.grid, { maxMismatchRate: this.maxMismatchRate });
    if (found.kind === "no_match" || found.ranked[0]!.score > this.maxOff) {
      this.restart(null);
      this.misses++;
      this.lost = this.misses >= this.lostAfter;
      return { kind: this.lost ? "lost" : "waiting", move: null, san: null, match: found };
    }
    this.misses = 0;
    this.lost = false;

    if (found.kind === "tie") return { kind: "waiting", move: null, san: null, match: found };
    const uci = found.move?.lan ?? null;
    if (uci !== this.candidate) this.restart(uci);
    this.frames++;
    this.gathered += found.margin;
    if (found.move === null) return { kind: "waiting", move: null, san: null, match: found };
    if (this.frames < this.confirm || this.gathered < this.evidence) {
      return { kind: "seen", move: found.move, san: null, match: found };
    }

    this.board.move(found.move.lan);
    this.restart(null);
    return { kind: "committed", move: found.move, san: found.move.san, match: found };
  }

  private restart(candidate: string | null): void {
    this.candidate = candidate;
    this.frames = 0;
    this.gathered = 0;
  }
}
