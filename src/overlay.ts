/**
 * The video overlay: a "tactical map" of the position in the corner, and the suggested move drawn
 * onto the real board in the frame (outline, highlighted squares, wireframe boxes, arrow, label).
 *
 * Drawn as one SVG over each frame. The on-board part needs the board's corners in the frame;
 * without them only the map is drawn.
 */

import { Chess } from "chess.js";
import sharp from "sharp";

import { type Corners, type Homography, type Point, boardToImage, project, squareCenter, squareInImage } from "./geometry.js";

export interface OverlayState {
  fen: string;
  myColor: "w" | "b";
  suggestion: { from: string; to: string; san: string; piece: string } | null;
  status: string; // shown when there's no suggestion, e.g. "Waiting for opponent"
  corners: Corners | null;
}

const CYAN = "#22d3ee";
const GREEN = "#4ade80";
const PIECE_NAMES: Record<string, string> = { p: "PAWN", n: "KNIGHT", b: "BISHOP", r: "ROOK", q: "QUEEN", k: "KING" };
const GLYPHS: Record<string, string> = { k: "♚", q: "♛", r: "♜", b: "♝", n: "♞", p: "♟" };
const MONO = "Menlo, Monaco, monospace";

/** The frame with the overlay drawn on it, as JPEG. */
export async function renderOverlay(jpeg: Buffer, state: OverlayState): Promise<Buffer> {
  const { width = 0, height = 0 } = await sharp(jpeg).metadata();
  const svg = overlaySvg(state, width, height);
  return sharp(jpeg)
    .composite([{ input: Buffer.from(svg) }])
    .jpeg({ quality: 80 })
    .toBuffer();
}

export function overlaySvg(state: OverlayState, width: number, height: number): string {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) throw new Error("invalid frame dimensions");
  const move = state.suggestion;
  if (move && (!/^[a-h][1-8]$/.test(move.from) || !/^[a-h][1-8]$/.test(move.to))) state = { ...state, suggestion: null };
  let board = "";
  try {
    if (state.corners) board = onBoard(state, state.corners, width, height);
  } catch {
    // A bad locate must never prevent the tactical map or video from rendering.
  }
  const parts = [board, tacticalMap(state, width)];
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${parts.join("")}</svg>`;
}

// ---- the map in the corner ------------------------------------------------------------------

function tacticalMap(state: OverlayState, width: number): string {
  const margin = Math.round(width * 0.02);
  const panel = Math.round(width * 0.28);
  const pad = Math.round(panel * 0.05);
  const cell = (panel - 2 * pad) / 8;
  const header = cell * 0.9;
  const footer = cell * 1.6;
  const font = cell * 0.36;
  const x0 = margin + pad;
  const y0 = margin + pad + header;
  const height = pad * 2 + header + cell * 8 + footer;
  const out: string[] = [];

  out.push(
    `<rect x="${margin}" y="${margin}" width="${panel}" height="${height}" rx="${pad}" fill="rgba(8,18,24,0.72)" stroke="${CYAN}" stroke-width="${Math.max(2, panel / 200)}"/>`,
    text(x0, margin + pad + header * 0.6, "TACTICAL MAP", { size: font, fill: CYAN, weight: "bold" }),
    `<circle cx="${margin + panel - pad - font * 3.3}" cy="${margin + pad + header * 0.45}" r="${font * 0.28}" fill="#ef4444"/>`,
    text(margin + panel - pad, margin + pad + header * 0.6, "LIVE", { size: font, fill: "#cbd5e1", anchor: "end" }),
  );

  // squares from the wearer's side: their pieces at the bottom
  const at = (square: string): Point => {
    const file = square.charCodeAt(0) - 97;
    const rank = Number(square[1]) - 1;
    const col = state.myColor === "w" ? file : 7 - file;
    const row = state.myColor === "w" ? 7 - rank : rank;
    return [x0 + col * cell, y0 + row * cell];
  };
  out.push(`<rect x="${x0}" y="${y0}" width="${cell * 8}" height="${cell * 8}" fill="rgba(255,255,255,0.06)"/>`);

  const move = state.suggestion;
  if (move) {
    const [fx, fy] = at(move.from);
    const [tx, ty] = at(move.to);
    const inset = cell * 0.04;
    out.push(
      `<rect x="${tx + inset}" y="${ty + inset}" width="${cell - 2 * inset}" height="${cell - 2 * inset}" fill="${GREEN}" fill-opacity="0.35" stroke="${GREEN}" stroke-width="${cell * 0.05}"/>`,
      `<rect x="${fx + inset}" y="${fy + inset}" width="${cell - 2 * inset}" height="${cell - 2 * inset}" fill="none" stroke="${GREEN}" stroke-width="${cell * 0.05}"/>`,
      arrow([fx + cell / 2, fy + cell / 2], [tx + cell / 2, ty + cell / 2], cell * 0.1, cell * 0.3, GREEN, 0.9),
    );
  }

  const board = new Chess(state.fen);
  for (const row of board.board()) {
    for (const piece of row) {
      if (!piece) continue;
      const [x, y] = at(piece.square);
      const white = piece.color === "w";
      out.push(
        text(x + cell / 2, y + cell * 0.8, GLYPHS[piece.type], {
          size: cell * 0.82,
          fill: white ? "#ffffff" : "#0b0f12",
          stroke: white ? "#0b0f12" : GREEN,
          strokeWidth: cell * 0.025,
          anchor: "middle",
          family: "Apple Symbols, Arial Unicode MS, sans-serif",
        }),
      );
    }
  }

  const fy = y0 + cell * 8;
  out.push(text(x0, fy + footer * 0.4, "NEXT MOVE", { size: font * 0.95, fill: "#94a3b8" }));
  if (move) {
    out.push(
      text(x0, fy + footer * 0.8, `${move.from} → ${move.to}`, { size: font * 1.05, fill: GREEN }),
      text(margin + panel - pad, fy + footer * 0.8, moveNumber(state.fen, move.san), { size: font * 1.05, fill: "#e2e8f0", anchor: "end" }),
    );
  } else {
    out.push(text(x0, fy + footer * 0.8, state.status.toUpperCase(), { size: font * 0.95, fill: "#cbd5e1" }));
  }
  return out.join("");
}

/** "1… e5" for Black's first move, "12. Nf3" for White's twelfth. */
function moveNumber(fen: string, san: string): string {
  const [, turn, , , , full] = fen.split(" ");
  return turn === "w" ? `${full}. ${san}` : `${full}… ${san}`;
}

// ---- on the real board ----------------------------------------------------------------------

function onBoard(state: OverlayState, corners: Corners, width: number, height: number): string {
  let h: Homography;
  try {
    h = boardToImage(corners);
  } catch {
    return ""; // corners that don't make a board
  }
  const px = ([x, y]: Point): Point => [x * width, y * height];
  const at = (u: number, v: number) => px(project(h, [u, v]));
  const outline = [at(0, 0), at(8, 0), at(8, 8), at(0, 8)];
  const scale = distance(outline[0], outline[1]) / 8; // about one square, in pixels
  const out: string[] = [];

  // the board: a glowing cyan outline with brackets past the far corners
  out.push(
    polygon(outline, { stroke: CYAN, width: scale * 0.22, opacity: 0.25 }),
    polygon(outline, { stroke: CYAN, width: Math.max(3, scale * 0.06) }),
    polyline([at(-0.15, 8.15), at(0.9, 8.15)], { stroke: CYAN, width: Math.max(3, scale * 0.05) }),
    polyline([at(-0.15, 8.15), at(-0.15, 7.1)], { stroke: CYAN, width: Math.max(3, scale * 0.05) }),
    polyline([at(8.15, 8.15), at(7.1, 8.15)], { stroke: CYAN, width: Math.max(3, scale * 0.05) }),
    polyline([at(8.15, 8.15), at(8.15, 7.1)], { stroke: CYAN, width: Math.max(3, scale * 0.05) }),
  );

  const move = state.suggestion;
  if (!move) return out.join("");
  const from = squareInImage(h, move.from, state.myColor).map(px);
  const to = squareInImage(h, move.to, state.myColor).map(px);
  const fromSize = distance(from[0], from[1]);
  const toSize = distance(to[0], to[1]);

  out.push(
    polygon(to, { stroke: GREEN, width: toSize * 0.25, opacity: 0.25 }),
    polygon(to, { stroke: GREEN, width: Math.max(3, toSize * 0.05), fill: GREEN, fillOpacity: 0.4 }),
    cuboid(to, toSize * 0.9),
    cuboid(from, fromSize * 0.9),
  );
  const start = px(squareCenter(h, move.from, state.myColor));
  const end = px(squareCenter(h, move.to, state.myColor));
  out.push(
    arrow(start, end, fromSize * 0.3, fromSize * 0.75, GREEN, 0.25, fromSize * 0.28),
    arrow(start, end, fromSize * 0.16, fromSize * 0.55, GREEN, 0.85),
  );

  // the label, off to the side of the piece to move, with a leader line to its box
  const anchor: Point = [from[2][0], from[2][1] - fromSize * 0.9];
  const right = anchor[0] < width * 0.6;
  const font = Math.max(16, width * 0.017);
  const boxWidth = font * 11.5;
  const boxHeight = font * 2.7;
  const bx = right ? anchor[0] + font * 3 : anchor[0] - font * 3 - boxWidth;
  const by = anchor[1] - font * 3.5;
  const elbow: Point = [right ? bx : bx + boxWidth, by + boxHeight / 2];
  out.push(
    polyline([anchor, [anchor[0] + (right ? font : -font), elbow[1]], elbow], { stroke: GREEN, width: Math.max(2, font * 0.1) }),
    `<rect x="${bx}" y="${by}" width="${boxWidth}" height="${boxHeight}" fill="rgba(8,18,24,0.82)" stroke="${GREEN}" stroke-width="${Math.max(2, font * 0.1)}"/>`,
    text(bx + font * 0.5, by + font * 1.05, "NEXT MOVE", { size: font * 0.8, fill: GREEN }),
    text(bx + font * 0.5, by + font * 2.25, `${PIECE_NAMES[move.piece] ?? ""}  ${move.from} → ${move.to}`, {
      size: font * 1.15,
      fill: "#ffffff",
      weight: "bold",
    }),
  );
  return out.join("");
}

/** A wireframe box standing on a square: its outline, the same raised by `rise` pixels, and the uprights. */
function cuboid(base: Point[], rise: number): string {
  const top = base.map(([x, y]): Point => [x, y - rise]);
  const width = Math.max(2, rise * 0.05);
  return [
    polygon(base, { stroke: GREEN, width }),
    polygon(top, { stroke: GREEN, width }),
    ...base.map((point, i) => polyline([point, top[i]], { stroke: GREEN, width })),
  ].join("");
}

function arrow(from: Point, to: Point, shaft: number, head: number, color: string, opacity: number, extra = 0): string {
  const length = distance(from, to);
  if (length < 1) return "";
  const [dx, dy] = [(to[0] - from[0]) / length, (to[1] - from[1]) / length];
  const base: Point = [to[0] - dx * head, to[1] - dy * head];
  const side = (p: Point, d: number): Point => [p[0] - dy * d, p[1] + dx * d];
  const tip: Point = [to[0] + dx * extra * 0.5, to[1] + dy * extra * 0.5];
  return [
    polyline([from, base], { stroke: color, width: shaft, opacity }),
    `<polygon points="${pts([side(base, head * 0.6 + extra / 2), tip, side(base, -head * 0.6 - extra / 2)])}" fill="${color}" fill-opacity="${opacity}"/>`,
  ].join("");
}

// ---- SVG helpers ------------------------------------------------------------------------------

interface Stroke {
  stroke: string;
  width: number;
  opacity?: number;
  fill?: string;
  fillOpacity?: number;
}

function polygon(points: Point[], s: Stroke): string {
  return `<polygon points="${pts(points)}" fill="${s.fill ?? "none"}" fill-opacity="${s.fillOpacity ?? 1}" stroke="${s.stroke}" stroke-width="${s.width.toFixed(1)}" stroke-opacity="${s.opacity ?? 1}" stroke-linejoin="round"/>`;
}

function polyline(points: Point[], s: Stroke): string {
  return `<polyline points="${pts(points)}" fill="none" stroke="${s.stroke}" stroke-width="${s.width.toFixed(1)}" stroke-opacity="${s.opacity ?? 1}" stroke-linecap="round" stroke-linejoin="round"/>`;
}

interface TextStyle {
  size: number;
  fill: string;
  weight?: string;
  anchor?: "start" | "middle" | "end";
  family?: string;
  stroke?: string;
  strokeWidth?: number;
}

function text(x: number, y: number, content: string, s: TextStyle): string {
  const stroke = s.stroke ? ` stroke="${s.stroke}" stroke-width="${(s.strokeWidth ?? 1).toFixed(1)}"` : "";
  return `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" font-family="${s.family ?? MONO}" font-size="${s.size.toFixed(1)}" font-weight="${s.weight ?? "normal"}" text-anchor="${s.anchor ?? "start"}" fill="${s.fill}"${stroke}>${escape(content)}</text>`;
}

const pts = (points: Point[]) => points.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
const distance = (a: Point, b: Point) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
