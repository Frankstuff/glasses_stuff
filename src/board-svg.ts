/** The board as SVG for the command center, like python-chess's `chess.svg.board`. */

import { Chess } from "chess.js";

import { squareIndex } from "./game.js";

const SQUARE = 45;
const MARGIN = 15;
const SIZE = 8 * SQUARE + 2 * MARGIN; // 390, the same view box as python-chess
const COLORS = {
  light: "#ffce9e",
  dark: "#d18b47",
  lightLastMove: "#cdd16a",
  darkLastMove: "#aaa23b",
  margin: "#212121",
  coordinate: "#e5e5e5",
};
// One glyph per piece type, colored by fill. U+FE0E asks for the text form, never an emoji.
const GLYPHS: Record<string, string> = { k: "♚", q: "♛", r: "♜", b: "♝", n: "♞", p: "♟" };

export interface BoardSvgOptions {
  orientation?: "w" | "b"; // whose side is at the bottom
  lastMove?: { from: string; to: string } | null;
  arrow?: { from: string; to: string; color?: string } | null;
  size?: number;
}

export function boardSvg(fen: string, { orientation = "w", lastMove = null, arrow = null, size = 420 }: BoardSvgOptions = {}): string {
  const board = new Chess(fen).board(); // rank 8 first, files a to h
  const displaySize = Number.isFinite(size) && size > 0 ? size : 420;
  const highlighted = new Set(lastMove ? [lastMove.from, lastMove.to] : []);
  // Screen position of a square (by index, a1 = 0): column and row counted from the top left.
  const place = (index: number) => {
    const file = index % 8;
    const rank = Math.floor(index / 8);
    const column = orientation === "w" ? file : 7 - file;
    const row = orientation === "w" ? 7 - rank : rank;
    return { x: MARGIN + column * SQUARE, y: MARGIN + row * SQUARE };
  };

  const parts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SIZE} ${SIZE}" width="${displaySize}" height="${displaySize}">`,
    `<rect x="0" y="0" width="${SIZE}" height="${SIZE}" fill="${COLORS.margin}"/>`,
  ];
  for (let index = 0; index < 64; index++) {
    const name = `${"abcdefgh"[index % 8]}${Math.floor(index / 8) + 1}`;
    const light = (index % 8 + Math.floor(index / 8)) % 2 === 1; // a1 is dark
    const fill = highlighted.has(name)
      ? light ? COLORS.lightLastMove : COLORS.darkLastMove
      : light ? COLORS.light : COLORS.dark;
    const { x, y } = place(index);
    parts.push(`<rect class="square ${name}" x="${x}" y="${y}" width="${SQUARE}" height="${SQUARE}" fill="${fill}"/>`);
  }
  board.forEach((row, i) =>
    row.forEach((piece, file) => {
      if (!piece) return;
      const { x, y } = place(file + 8 * (7 - i));
      const fill = piece.color === "w" ? "#ffffff" : "#000000";
      parts.push(
        `<text class="piece ${piece.color}${piece.type}" x="${x + SQUARE / 2}" y="${y + SQUARE / 2}" ` +
          `font-size="36" text-anchor="middle" dominant-baseline="central" fill="${fill}" stroke="#000000" ` +
          `stroke-width="0.8">${GLYPHS[piece.type]}︎</text>`,
      );
    }),
  );
  for (let i = 0; i < 8; i++) {
    const file = "abcdefgh"[orientation === "w" ? i : 7 - i];
    const rank = String(orientation === "w" ? 8 - i : i + 1);
    const along = MARGIN + i * SQUARE + SQUARE / 2;
    const attributes = `font-size="11" text-anchor="middle" dominant-baseline="central" fill="${COLORS.coordinate}"`;
    parts.push(`<text ${attributes} x="${along}" y="${MARGIN / 2}">${file}</text>`);
    parts.push(`<text ${attributes} x="${along}" y="${SIZE - MARGIN / 2}">${file}</text>`);
    parts.push(`<text ${attributes} x="${MARGIN / 2}" y="${along}">${rank}</text>`);
    parts.push(`<text ${attributes} x="${SIZE - MARGIN / 2}" y="${along}">${rank}</text>`);
  }
  if (arrow && /^[a-h][1-8]$/.test(arrow.from) && /^[a-h][1-8]$/.test(arrow.to)) {
    // Color is an attribute value; do not let a caller insert SVG markup.
    const color = (arrow.color ?? "#2e9f5b").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]!);
    parts.push(arrowSvg(place(squareIndex(arrow.from)), place(squareIndex(arrow.to)), color));
  }
  parts.push("</svg>");
  return parts.join("");
}

function arrowSvg(from: { x: number; y: number }, to: { x: number; y: number }, color: string): string {
  const [x1, y1] = [from.x + SQUARE / 2, from.y + SQUARE / 2];
  const [x2, y2] = [to.x + SQUARE / 2, to.y + SQUARE / 2];
  const length = Math.hypot(x2 - x1, y2 - y1);
  if (length < 1) return "";
  const [dx, dy] = [(x2 - x1) / length, (y2 - y1) / length];
  const head = SQUARE * 0.45;
  const [bx, by] = [x2 - dx * head, y2 - dy * head]; // where the head starts
  const [px, py] = [-dy * head * 0.55, dx * head * 0.55]; // half the head's width, sideways
  const round = (n: number) => Math.round(n * 10) / 10;
  return (
    `<g class="arrow" opacity="0.8">` +
    `<line x1="${round(x1)}" y1="${round(y1)}" x2="${round(bx)}" y2="${round(by)}" stroke="${color}" stroke-width="${SQUARE * 0.2}" stroke-linecap="butt"/>` +
    `<polygon points="${round(x2)},${round(y2)} ${round(bx + px)},${round(by + py)} ${round(bx - px)},${round(by - py)}" fill="${color}"/>` +
    `</g>`
  );
}
