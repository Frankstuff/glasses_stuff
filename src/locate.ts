/**
 * Where the board is in a frame: its four corners, for drawing the overlay onto the real board.
 *
 * Asked of the vision model on its own, every few seconds while the overlay is in use. Tried on
 * the example clips (2026-10-17), gpt-6.1-sol placed the 8×8 grid best; Opus and gpt-6-luna were
 * close on one clip and off on the other; Haiku was off; Jev's boxes couldn't find the corners.
 */

import type { Frame } from "./capture.js";
import { type Corners, type Point, boardToImage } from "./geometry.js";
import type { Answer, Vision } from "./vision.js";

const PROMPT =
  "Find the four outer corners of the board's playing area in this frame: the 8×8 grid of 64 squares, not the border " +
  "around it where letters and numbers are printed. Give each corner as x and y on a 0–1000 scale: x across the image " +
  "from its left edge, y down the image from its top edge. If a corner is cut off by the edge of the frame, estimate " +
  "where it would be by extending the grid: values below 0 or above 1000 are fine. near_left and near_right are the two " +
  "ends of the grid's edge closest to the camera, as seen in the frame (left and right in the image); far_left and " +
  "far_right are the ends of the edge farthest away. Set board_visible to false if no chessboard is in the frame.";

const POINT = { type: "object", properties: { x: { type: "number" }, y: { type: "number" } }, required: ["x", "y"], additionalProperties: false };
const CORNERS = ["near_left", "near_right", "far_right", "far_left"] as const;
const SCHEMA = {
  type: "object",
  properties: { board_visible: { type: "boolean" }, ...Object.fromEntries(CORNERS.map((name) => [name, POINT])) },
  required: ["board_visible", ...CORNERS],
  additionalProperties: false,
};

export interface Located {
  corners: Corners | null; // null when there's no board in the frame, or the answer was unusable
  answer: Answer;
}

export class Locator {
  constructor(readonly vision: Pick<Vision, "send" | "model">) {}

  async locate(frame: Frame, signal?: AbortSignal): Promise<Located> {
    const answer = await this.vision.send([frame, PROMPT], SCHEMA, signal);
    return { corners: corners(answer), answer };
  }
}

function corners(answer: Answer): Corners | null {
  const data = answer.data;
  if (answer.error !== null || !data || data.board_visible !== true) return null;
  const point = (name: string): Point | null => {
    const p = data[name] as { x?: unknown; y?: unknown } | undefined;
    return typeof p?.x === "number" && Number.isFinite(p.x) && typeof p.y === "number" && Number.isFinite(p.y) ? [p.x / 1000, p.y / 1000] : null;
  };
  const [nearLeft, nearRight, farRight, farLeft] = CORNERS.map(point);
  if (!nearLeft || !nearRight || !farRight || !farLeft) return null;
  const found = { nearLeft, nearRight, farRight, farLeft };
  try {
    boardToImage(found);
    return found;
  } catch {
    return null;
  }
}
