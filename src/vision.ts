/**
 * Ask a vision model what it sees on the board. It reports observations; code decides the move.
 *
 * Three ways of asking, compared in the vision test:
 * - occupancy: what is on each of the 64 squares (white, black, empty, or can't tell)
 * - changes:   which squares differ from an earlier frame whose position is known (the default)
 * - pick:      which legal move was played, if any (the baseline that invites guessing)
 *
 * The questions and answers are the same for every model; ClaudeVision and GptVision only differ
 * in how they send them.
 */

import Anthropic from "@anthropic-ai/sdk";
import { Chess } from "chess.js";
import OpenAI from "openai";

import type { Frame } from "./capture.js";
import { DEFAULT_MODEL, DEFAULT_STRATEGY, anthropicClient, openaiClient, provider } from "./config.js";
import { SQUARE_NAMES } from "./game.js";
import { Grid, type Reading, type Side } from "./match.js";

export type Strategy = "occupancy" | "changes" | "pick";
export const STRATEGIES: Strategy[] = ["occupancy", "changes", "pick"];
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";
export const PROMPT_VERSION = 2; // bump when a prompt changes, so cached eval answers aren't reused

const FLAGS =
  "Set board_visible to false if no chessboard is in view or most of it is hidden. " +
  "Set hand_over_board to true if a hand or arm is over the board or touching a piece.";
const COLORS: Record<string, Side | null> = { white: "w", black: "b", empty: null };
const RANK_KEYS = [8, 7, 6, 5, 4, 3, 2, 1].map((r) => `rank${r}`);

/** A model's raw answer to one question, and what it cost. */
export interface Answer {
  data: Record<string, unknown> | null;
  error: string | null;
  model: string;
  input_tokens: number;
  output_tokens: number;
  seconds: number;
}

export type Part = string | Frame;

export interface VisionOptions {
  strategy?: Strategy;
  model?: string;
  effort?: Effort;
  myColor?: Side;
}

/** The right Vision for `model`, with a client built from the saved key. */
export function makeVision(model: string = DEFAULT_MODEL, options: Omit<VisionOptions, "model"> = {}): Vision {
  return provider(model) === "openai"
    ? new GptVision(openaiClient(), { ...options, model })
    : new ClaudeVision(anthropicClient(), { ...options, model });
}

/** Builds the question for a frame and turns the answer into a Reading. */
export abstract class Vision {
  readonly strategy: Strategy;
  readonly model: string;
  readonly effort: Effort;
  private systemPrompt = "";

  get system(): string {
    return this.systemPrompt;
  }

  constructor({ strategy = DEFAULT_STRATEGY as Strategy, model = DEFAULT_MODEL, effort = "low", myColor = "w" }: VisionOptions = {}) {
    this.strategy = strategy;
    this.model = model;
    this.effort = effort;
    this.setColor(myColor);
  }

  /** Rebuild the orientation instructions when the wearer starts a game as the other color. */
  setColor(myColor: Side): void {
    const mine = myColor === "w" ? "white" : "black";
    const left = myColor === "w" ? "a" : "h";
    this.systemPrompt =
      `You are the eyes of a chess move tracker. The images come from a camera on the ` +
      `glasses of the player with the ${mine} pieces, sitting at a physical chessboard. The ` +
      `${mine} pieces start on the two ranks nearest the camera, and the ${left}-file is on ` +
      `the left as the camera sees it.\n\n` +
      "Report only what you can see. Never fill in a square from chess knowledge or from " +
      "which move seems likely. If you can't see a square clearly, say so.";
  }

  /**
   * Ask about `frame`. `fen` is the last committed position; `reference` (for the changes
   * strategy) is the frame where that position was confirmed.
   */
  ask(frame: Frame, fen: string, reference: Frame | null = null, signal?: AbortSignal): Promise<Answer> {
    signal?.throwIfAborted();
    const [parts, schema] = this.question(frame, fen, reference);
    return this.call(parts, schema, signal);
  }

  /** Ask any other question about frames (the board locator uses this), answered as `schema`. */
  send(parts: Part[], schema: Record<string, unknown>, signal?: AbortSignal): Promise<Answer> {
    signal?.throwIfAborted();
    return this.call(parts, schema, signal);
  }

  /** Send the question (text and frames, in order) to the model. */
  protected abstract call(parts: Part[], schema: Record<string, unknown>, signal?: AbortSignal): Promise<Answer>;

  /** Turn an answer into a Reading of the board. `fen` must be the one passed to ask(). */
  reading(answer: Answer, fen: string): Reading {
    const data = answer.data;
    if (data === null) return { boardVisible: false, handOverBoard: false, grid: null };
    let grid: Grid | null;
    try {
      if (this.strategy === "occupancy") {
        grid = Grid.fromRows(RANK_KEYS.map((key) => String(data[key]).replaceAll(" ", "").toLowerCase()));
      } else if (this.strategy === "changes") {
        grid = Grid.of(fen);
        for (const change of data.changes as { square: string; now: string }[]) {
          if (!(change.now in COLORS)) throw new Error(`unknown occupant ${change.now}`);
          grid = grid.set(change.square, COLORS[change.now]);
        }
      } else {
        const after = new Chess(fen);
        if (data.move !== "none") after.move(String(data.move));
        grid = Grid.of(after.fen());
      }
    } catch {
      grid = null;
    }
    return { boardVisible: Boolean(data.board_visible), handOverBoard: Boolean(data.hand_over_board), grid };
  }

  /** The question as text and frames in order, plus the JSON schema of the answer. */
  question(frame: Frame, fen: string, reference: Frame | null): [Part[], Record<string, unknown>] {
    const flags = { board_visible: { type: "boolean" }, hand_over_board: { type: "boolean" } };

    if (this.strategy === "occupancy") {
      const text =
        "Report what is on each square of the board in this frame. For each rank, give 8 " +
        "characters for files a to h: w = white piece, b = black piece, . = empty, " +
        '? = can\'t tell (hidden, blurry, or out of view). For example "..b.w..?" means a ' +
        "black piece on c, a white piece on e, h can't be seen, and the rest are empty. " +
        `${FLAGS} If no board is visible, use "????????" for every rank.`;
      const fields = Object.fromEntries(RANK_KEYS.map((key) => [key, { type: "string" }]));
      return [[frame, text], schema({ ...flags, ...fields })];
    }

    if (this.strategy === "changes") {
      if (reference === null) throw new Error("the changes strategy needs a reference frame");
      const rows = Grid.of(fen)
        .rows()
        .map((row, i) => `rank ${8 - i}: ${row}`)
        .join("\n");
      const before =
        "Image 1 is an earlier frame. At that moment the squares were occupied like this " +
        `(files a to h; w = white piece, b = black piece, . = empty):\n${rows}`;
      const after =
        "Image 2 is the current frame. List every square whose occupant is different in " +
        "image 2 than in image 1, with what is on it now. A piece that only shifted within " +
        `its square doesn't count. If nothing changed, return an empty list. ${FLAGS} ` +
        "(Both about image 2.)";
      const change = schema({
        square: { type: "string", enum: SQUARE_NAMES },
        now: { type: "string", enum: Object.keys(COLORS) },
      });
      return [[before, reference, "Image 2:", frame, after], schema({ ...flags, changes: { type: "array", items: change } })];
    }

    const board = new Chess(fen);
    const side = board.turn() === "w" ? "White" : "Black";
    const legal = board.moves({ verbose: true });
    const moves = legal.map((move) => `${move.lan} (${move.san})`).join(", ");
    const text =
      `Before this frame the position was ${fen} (${side} to move). Has ${side} ` +
      `completed a move since then? If so, which of these: ${moves}. Answer "none" if the ` +
      `position looks unchanged or a move is still in progress. ${FLAGS}`;
    const choices = [...legal.map((move) => move.lan), "none"];
    return [[frame, text], schema({ ...flags, move: { type: "string", enum: choices } })];
  }

  protected failed(error: string, started: number): Answer {
    return { data: null, error, model: this.model, input_tokens: 0, output_tokens: 0, seconds: elapsed(started) };
  }
}

export class ClaudeVision extends Vision {
  constructor(readonly client: Anthropic, options: VisionOptions = {}) {
    super({ model: "claude-sonnet-5-5", ...options });
  }

  protected override async call(parts: Part[], outputSchema: Record<string, unknown>, signal?: AbortSignal): Promise<Answer> {
    const content: Anthropic.ContentBlockParam[] = parts.map((part) =>
      typeof part === "string"
        ? { type: "text", text: part }
        : { type: "image", source: { type: "base64", media_type: "image/jpeg", data: part.jpeg.toString("base64") } },
    );
    const params: Anthropic.MessageCreateParamsNonStreaming = {
      model: this.model,
      max_tokens: 4096,
      system: this.system,
      messages: [{ role: "user" as const, content }],
      output_config: { effort: this.effort, format: { type: "json_schema" as const, schema: outputSchema } },
    };
    const started = performance.now();
    let response: Anthropic.Message;
    try {
      response = await this.client.messages.create(params, { signal });
    } catch (error) {
      signal?.throwIfAborted();
      if (error instanceof Anthropic.APIConnectionError) return this.failed(`connection: ${error.message}`, started);
      if (error instanceof Anthropic.APIError && (error.status === 429 || (error.status ?? 0) >= 500)) {
        return this.failed(`${error.status}: ${error.message}`, started);
      }
      throw error; // a bad key, model, or request fails every time: stop instead of retrying
    }
    const result = {
      model: response.model,
      input_tokens: response.usage.input_tokens,
      output_tokens: response.usage.output_tokens,
      seconds: elapsed(started),
    };
    if (response.stop_reason === "refusal" || response.stop_reason === "max_tokens") {
      return { data: null, error: `stop_reason ${response.stop_reason}`, ...result };
    }
    const text = response.content.find((block) => block.type === "text");
    return parsed(text && "text" in text ? text.text : "", result);
  }
}

export class GptVision extends Vision {
  constructor(readonly client: OpenAI, options: VisionOptions = {}) {
    super(options);
  }

  protected override async call(parts: Part[], outputSchema: Record<string, unknown>, signal?: AbortSignal): Promise<Answer> {
    const content: OpenAI.Responses.ResponseInputContent[] = parts.map((part) =>
      typeof part === "string"
        ? { type: "input_text", text: part }
        : { type: "input_image", image_url: `data:image/jpeg;base64,${part.jpeg.toString("base64")}`, detail: "high" },
    );
    const started = performance.now();
    let response: OpenAI.Responses.Response;
    try {
      response = await this.client.responses.create({
        model: this.model,
        instructions: this.system,
        input: [{ role: "user", content }],
        text: { format: { type: "json_schema", name: "board_reading", strict: true, schema: outputSchema } },
        reasoning: { effort: this.effort },
        max_output_tokens: 16000,
      }, { signal });
    } catch (error) {
      signal?.throwIfAborted();
      if (error instanceof OpenAI.APIConnectionError) return this.failed(`connection: ${error.message}`, started);
      if (error instanceof OpenAI.APIError && (error.status === 429 || (error.status ?? 0) >= 500)) {
        return this.failed(`${error.status}: ${error.message}`, started);
      }
      throw error; // a bad key, model, or request fails every time
    }
    const result = {
      model: response.model,
      input_tokens: response.usage?.input_tokens ?? 0,
      output_tokens: response.usage?.output_tokens ?? 0,
      seconds: elapsed(started),
    };
    if (response.status !== "completed") return { data: null, error: `status ${response.status}`, ...result };
    for (const item of response.output) {
      if (item.type === "message" && item.content.some((part) => part.type === "refusal")) {
        return { data: null, error: "refusal", ...result };
      }
    }
    return parsed(response.output_text, result);
  }
}

function parsed(text: string, result: Omit<Answer, "data" | "error">): Answer {
  try {
    const data: unknown = JSON.parse(text);
    if (data === null || typeof data !== "object" || Array.isArray(data)) {
      return { data: null, error: "expected a JSON object", ...result };
    }
    return { data: data as Record<string, unknown>, error: null, ...result };
  } catch {
    return { data: null, error: `not JSON: ${text.slice(0, 200)}`, ...result };
  }
}

function schema(properties: Record<string, unknown>): Record<string, unknown> {
  return { type: "object", properties, required: Object.keys(properties), additionalProperties: false };
}

const elapsed = (started: number) => (performance.now() - started) / 1000;
