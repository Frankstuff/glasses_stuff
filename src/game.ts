/** Chess helpers: how a move is said aloud, move text, PGN, and which squares are occupied. */

import { Chess, type Move, type PieceSymbol } from "chess.js";

const PIECE_NAMES: Record<PieceSymbol, string> = {
  p: "Pawn",
  n: "Knight",
  b: "Bishop",
  r: "Rook",
  q: "Queen",
  k: "King",
};

// SAN for a piece move, e.g. "Nbd7" -> disambiguation "b". Pawn moves and castling don't match.
const PIECE_SAN = /^[NBRQK]([a-h]?[1-8]?)x?[a-h][1-8]/;

/** How `move` is said aloud, e.g. "Knight b to d7" for Nbd7. */
export function spoken(move: Move): string {
  const san = move.san;
  let text: string;
  if (move.isKingsideCastle()) {
    text = "Castle kingside";
  } else if (move.isQueensideCastle()) {
    text = "Castle queenside";
  } else {
    const capture = move.captured !== undefined; // chess.js's isCapture() is false for en passant
    if (move.piece === "p") {
      text = capture ? `Pawn ${move.from[0]} takes ${move.to}` : `Pawn to ${move.to}`;
      if (move.isEnPassant()) text += ", en passant";
      if (move.promotion) text += `, promote to ${PIECE_NAMES[move.promotion].toLowerCase()}`;
    } else {
      const which = PIECE_SAN.exec(san)?.[1] ?? "";
      const origin = which ? ` ${which}` : "";
      text = `${PIECE_NAMES[move.piece]}${origin} ${capture ? "takes" : "to"} ${move.to}`;
    }
  }
  if (san.endsWith("#")) text += ", checkmate";
  else if (san.endsWith("+")) text += ", check";
  return text;
}

/** `uci` (like "e2e4") as a chess.js Move in `fen`'s position, or null if it isn't legal there. */
export function moveFrom(fen: string, uci: string): Move | null {
  try {
    return new Chess(fen).move(uci);
  } catch {
    return null;
  }
}

/** Moves numbered from `startFen`, like python-chess: "1. e4 e5 2. Nf3", or "12...Kg6 13. Rf1". */
export function movesText(startFen: string, sans: string[]): string {
  const [, turn, , , , fullmove] = startFen.split(" ");
  let number = Number(fullmove) || 1;
  let white = turn !== "b";
  const parts: string[] = [];
  sans.forEach((san, i) => {
    if (white) {
      parts.push(`${number}. ${san}`);
    } else {
      parts.push(i === 0 ? `${number}...${san}` : san);
      number++;
    }
    white = !white;
  });
  return parts.join(" ");
}

export interface Outcome {
  termination: "checkmate" | "stalemate" | "insufficient_material" | "seventyfive_moves" | "fivefold_repetition";
  winner: "w" | "b" | null;
  result: "1-0" | "0-1" | "1/2-1/2";
}

/**
 * How the game ended, or null if it hasn't. Like python-chess's `outcome()`: draws that a player
 * has to claim (threefold repetition, the 50-move rule) don't end it. chess.js's isGameOver()
 * would, so it isn't used.
 */
export function gameOver(board: Chess): Outcome | null {
  if (board.isCheckmate()) {
    const winner = board.turn() === "w" ? "b" : "w";
    return { termination: "checkmate", winner, result: winner === "w" ? "1-0" : "0-1" };
  }
  const draw = (termination: Outcome["termination"]): Outcome => ({ termination, winner: null, result: "1/2-1/2" });
  if (board.isStalemate()) return draw("stalemate");
  if (board.isInsufficientMaterial()) return draw("insufficient_material");
  if (Number(board.fen().split(" ")[4]) >= 150) return draw("seventyfive_moves");
  const position = (fen: string) => fen.split(" ").slice(0, 4).join(" ");
  const current = position(board.fen());
  const replay = new Chess(startFen(board));
  let seen = position(replay.fen()) === current ? 1 : 0;
  for (const move of board.history({ verbose: true })) {
    replay.move(move.lan);
    if (position(replay.fen()) === current) seen++;
  }
  if (seen >= 5) return draw("fivefold_repetition");
  return null;
}

/** The position the game in `board` started from. */
export function startFen(board: Chess): string {
  return board.history({ verbose: true })[0]?.before ?? board.fen();
}

/** A copy of `board` with its move history, which `new Chess(board.fen())` would lose. */
export function copyBoard(board: Chess): Chess {
  const copy = new Chess(startFen(board));
  for (const move of board.history({ verbose: true })) copy.move(move.lan);
  return copy;
}

export function toPgn(board: Chess, white = "?", black = "?"): string {
  const copy = copyBoard(board);
  copy.setHeader("White", white);
  copy.setHeader("Black", black);
  return copy.pgn();
}

// Squares are numbered like python-chess: a1 = 0, b1 = 1, ... h8 = 63.
export const SQUARE_NAMES = Array.from(
  { length: 64 },
  (_, i) => `${"abcdefgh"[i % 8]}${Math.floor(i / 8) + 1}`,
);

export function squareIndex(name: string): number {
  const file = name.charCodeAt(0) - 97;
  const rank = Number(name[1]) - 1;
  if (name.length !== 2 || file < 0 || file > 7 || !(rank >= 0 && rank <= 7)) {
    throw new Error(`not a square: ${name}`);
  }
  return file + 8 * rank;
}

export const EMPTY = 0;
export const WHITE = 1;
export const BLACK = 2;

/** Who occupies each square in a FEN position: EMPTY, WHITE or BLACK, indexed a1 = 0. */
export function occupancy(fen: string): Uint8Array {
  const cells = new Uint8Array(64);
  const ranks = fen.split(" ")[0].split("/");
  ranks.forEach((row, i) => {
    let file = 0;
    for (const char of row) {
      if (char >= "1" && char <= "8") {
        file += Number(char);
      } else {
        cells[file + 8 * (7 - i)] = char === char.toUpperCase() ? WHITE : BLACK;
        file++;
      }
    }
  });
  return cells;
}
