/**
 * A quick, cheap look with Jev (TypeSafe) before the expensive vision read.
 *
 * Jev answers yes/no questions about a frame in about half a second, for a fraction of a cent:
 * can the board be read, is a hand over it, and has any piece moved since an earlier frame that
 * showed the tracked position. Frames that can't be read, have a hand in the way, or show nothing
 * new don't need to go to the vision model.
 */

import { AuthenticationError, type NoulQuestion, TypeSafeClient, image, noul } from "@typesafe-ai/sdk";
import sharp from "sharp";

import type { Frame } from "./capture.js";

export const JEV_MODEL = "jev-1.14.0"; // pin the version used to tune thresholds and estimate cost
export const JEV_MAX_EDGE = 1568; // Jev rejects larger images instead of shrinking them

export const QUESTIONS: Record<"readable" | "hand" | "changed", NoulQuestion> = {
  readable: noul(
    "A physical chessboard is in view in `current_frame` and its squares and pieces can be " +
      "clearly made out: the photo is in focus and most of the board is inside the frame.",
  ),
  hand: noul("In `current_frame`, a hand or arm is over the chessboard or touching a chess piece."),
  changed: noul(
    "Compared with `earlier_frame`, has any chess piece in `current_frame` been moved to a " +
      "different square, added to the board, or taken off it? The photos are taken from a " +
      "moving head, so ignore differences in camera angle, zoom, lighting, blur, and any hands.",
  ),
};

export type Verdict = "ask_claude" | "unreadable" | "hand" | "unchanged";

export interface GateAnswer {
  readable: number | null;
  hand: number | null;
  changed: number | null; // null when there was no earlier frame to compare with
  model: string;
  input_tokens: number;
  seconds: number;
  error: string | null;
}

export interface GateOptions {
  model?: string;
  readableMin?: number;
  handMax?: number;
  unchangedMax?: number;
}

/**
 * Decides whether a frame is worth a vision read.
 *
 * `unchangedMax` is deliberately low: wrongly skipping a frame delays a move, while wrongly
 * sending one to the model only costs a call. The pre-check never stops a read: any failure
 * sends the frame on to the vision model, and a rejected key turns the pre-check off for the
 * rest of the run rather than failing on every frame.
 */
export class Gate {
  readonly model: string;
  readonly readableMin: number;
  readonly handMax: number;
  readonly unchangedMax: number;
  off: string | null = null; // why the pre-check stopped asking Jev, once it has

  constructor(
    readonly client: Pick<TypeSafeClient, "systemOne">,
    // a far-side pawn push scored 0.16 on the example clip, hence unchangedMax 0.1
    { model = JEV_MODEL, readableMin = 0.8, handMax = 0.5, unchangedMax = 0.1 }: GateOptions = {},
  ) {
    this.model = model;
    this.readableMin = readableMin;
    this.handMax = handMax;
    this.unchangedMax = unchangedMax;
  }

  async ask(frame: Frame, earlier: Frame | null = null, signal?: AbortSignal): Promise<GateAnswer> {
    signal?.throwIfAborted();
    const started = performance.now();
    let inputTokens = 0;
    let responseModel = this.model;
    const failed = (error: string): GateAnswer => ({
      readable: null,
      hand: null,
      changed: null,
      model: responseModel,
      input_tokens: inputTokens,
      seconds: (performance.now() - started) / 1000,
      error,
    });
    if (this.off !== null) return failed(this.off);
    try {
      const state: Record<string, string> = { current_frame: "<current_frame>" };
      const assets = { "<current_frame>": image(await fitForJev(frame.jpeg)) };
      const questions: Partial<typeof QUESTIONS> = { readable: QUESTIONS.readable, hand: QUESTIONS.hand };
      if (earlier !== null) {
        state.earlier_frame = "<earlier_frame>";
        Object.assign(assets, { "<earlier_frame>": image(await fitForJev(earlier.jpeg)) });
        questions.changed = QUESTIONS.changed;
      }
      signal?.throwIfAborted();
      const response = await this.client.systemOne({ state, questions, assets, model: this.model }, { signal });
      inputTokens = response.usage.input_tokens ?? 0;
      responseModel = response.model;
      const answers = response.answers as Record<string, { noul: number }>;
      for (const name of Object.keys(questions)) {
        const value = answers[name]?.noul;
        if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
          throw new Error(`Jev returned an invalid ${name} probability`);
        }
      }
      return {
        readable: answers.readable.noul,
        hand: answers.hand.noul,
        changed: answers.changed?.noul ?? null,
        model: response.model,
        input_tokens: response.usage.input_tokens ?? 0,
        seconds: (performance.now() - started) / 1000,
        error: null,
      };
    } catch (error) {
      signal?.throwIfAborted();
      const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      if (error instanceof AuthenticationError) this.off = `pre-check off, Jev rejected the key (${detail})`;
      return failed(this.off ?? detail);
    }
  }

  verdict(answer: GateAnswer, { maySkipUnchanged }: { maySkipUnchanged: boolean }): Verdict {
    if (answer.error !== null) return "ask_claude"; // the pre-check never blocks a read
    if ((answer.readable ?? 0) < this.readableMin) return "unreadable";
    if ((answer.hand ?? 0) > this.handMax) return "hand";
    if (maySkipUnchanged && answer.changed !== null && answer.changed < this.unchangedMax) return "unchanged";
    return "ask_claude";
  }
}

/** The frame shrunk to Jev's size limit, if it's over. */
export async function fitForJev(jpeg: Buffer): Promise<Buffer> {
  const { width = 0, height = 0 } = await sharp(jpeg).metadata();
  if (Math.max(width, height) <= JEV_MAX_EDGE) return jpeg;
  return sharp(jpeg)
    .resize({ width: JEV_MAX_EDGE, height: JEV_MAX_EDGE, fit: "inside" })
    .jpeg({ quality: 90 })
    .toBuffer();
}
