import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Anthropic from "@anthropic-ai/sdk";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import { Chess } from "chess.js";
import OpenAI from "openai";
import sharp from "sharp";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Frame } from "../src/capture.js";
import { anthropicKey, dataDir, openaiKey, provider, typesafeKey } from "../src/config.js";
import { checkAnthropic, checkBlackhole, checkJev, checkMacos, checkOpenai, checkScreenRecording, checkWhatsapp } from "../src/doctor.js";
import { Gate, JEV_MODEL } from "../src/gate.js";
import { KeychainError, readSecret, saveSecret } from "../src/keychain.js";
import { Grid } from "../src/match.js";
import { ClaudeVision, GptVision } from "../src/vision.js";

const fen = new Chess().fen();
const frame: Frame = { jpeg: Buffer.from("fake-jpeg-for-transport-test"), t: 1 };
const outputSchema = { type: "object", properties: { board_visible: { type: "boolean" } }, required: ["board_visible"], additionalProperties: false };

function openaiResponse(text = '{"board_visible":true}', overrides: Record<string, unknown> = {}) {
  return {
    id: "resp_test", object: "response", model: "gpt-6.1-sol", status: "completed",
    output: [{ type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] }],
    usage: { input_tokens: 123, output_tokens: 45, total_tokens: 168 }, ...overrides,
  };
}

function transport(body: Record<string, unknown>, status = 200) {
  const fetch = vi.fn(async (_url: unknown, _init?: RequestInit) => new Response(JSON.stringify(body), {
    status, headers: { "content-type": "application/json" },
  }));
  return { fetch, request: () => JSON.parse(String(fetch.mock.calls[0]?.[1]?.body)) };
}

function gpt(body: Record<string, unknown> = openaiResponse(), status = 200) {
  const wire = transport(body, status);
  return { ...wire, client: new OpenAI({ apiKey: "test-key-not-real", maxRetries: 0, fetch: wire.fetch }) };
}

afterEach(() => vi.unstubAllEnvs());

describe("vision prompts and adapters without network calls", () => {
  it("rebuilds orientation for a new wearer color and sends the updated prompt", async () => {
    const { client, request } = gpt();
    const vision = new GptVision(client);
    expect(vision.system).toContain("white pieces");
    expect(vision.system).toContain("a-file is on the left");
    vision.setColor("b");
    expect(vision.system).toContain("black pieces");
    expect(vision.system).toContain("h-file is on the left");
    expect(vision.system).not.toContain("{mine}");
    await vision.send([frame, "Read the board"], outputSchema);
    expect(request().instructions).toBe(vision.system);
    vision.setColor("w");
    expect(vision.system).toContain("a-file is on the left");
  });

  it("sends ordered base64 images, strict JSON schema, supported OpenAI effort, and accounts usage", async () => {
    const { client, request } = gpt();
    const vision = new GptVision(client, { effort: "max" });
    const answer = await vision.send(["Before", frame, "After"], outputSchema);
    const sent = request();
    expect(sent.model).toBe("gpt-6.1-sol");
    expect(sent.reasoning).toEqual({ effort: "max" });
    expect(sent.text.format).toEqual({ type: "json_schema", name: "board_reading", strict: true, schema: outputSchema });
    expect(sent.input[0].content).toEqual([
      { type: "input_text", text: "Before" },
      { type: "input_image", image_url: `data:image/jpeg;base64,${frame.jpeg.toString("base64")}`, detail: "high" },
      { type: "input_text", text: "After" },
    ]);
    expect(answer).toMatchObject({ data: { board_visible: true }, model: "gpt-6.1-sol", input_tokens: 123, output_tokens: 45, error: null });
  });

  it("includes the actual FEN and side to move in the pick question", () => {
    const { client } = gpt();
    const board = new Chess();
    board.move("e4");
    const vision = new GptVision(client, { strategy: "pick" });
    const [parts] = vision.question(frame, board.fen(), null);
    expect(parts[1]).toContain(board.fen());
    expect(parts[1]).toContain("Black to move");
    expect(parts[1]).toContain("e7e5 (e5)");
  });

  it("requires a reference for changes and includes it before the current frame", () => {
    const { client } = gpt();
    const vision = new GptVision(client);
    expect(() => vision.ask(frame, fen)).toThrow("reference frame");
    const reference = { jpeg: Buffer.from("earlier"), t: 0 };
    const [parts, schema] = vision.question(frame, fen, reference);
    expect(parts[1]).toBe(reference);
    expect(parts[3]).toBe(frame);
    expect(schema).toMatchObject({ additionalProperties: false, properties: { changes: { items: { additionalProperties: false } } } });
  });

  it("turns occupancy and a legal pick into matching grids and rejects malformed rows", () => {
    const { client } = gpt();
    const vision = new GptVision(client, { strategy: "occupancy" });
    const data = Object.fromEntries(Grid.of(fen).rows().map((row, i) => [`rank${8 - i}`, row]));
    const answer = { data: { ...data, board_visible: true, hand_over_board: false }, model: "gpt-6.1-sol", error: null, input_tokens: 0, output_tokens: 0, seconds: 0 };
    expect(vision.reading(answer, fen).grid?.equals(Grid.of(fen))).toBe(true);
    expect(vision.reading({ ...answer, data: { ...answer.data, rank8: "bad" } }, fen).grid).toBeNull();
    const pick = new GptVision(client, { strategy: "pick" });
    const board = new Chess(); board.move("e4");
    expect(pick.reading({ ...answer, data: { board_visible: true, hand_over_board: false, move: "e2e4" } }, fen).grid?.equals(Grid.of(board.fen()))).toBe(true);
  });

  it.each(["null", "[]", "42", "not JSON"])("reports an unusable response for %s", async (text) => {
    const { client } = gpt(openaiResponse(text));
    const answer = await new GptVision(client).send([frame], outputSchema);
    expect(answer.data).toBeNull();
    expect(answer.error).toBeTruthy();
    expect(answer.input_tokens).toBe(123);
  });

  it("retains usage when output is incomplete or refused", async () => {
    const incomplete = gpt(openaiResponse("", { status: "incomplete" }));
    expect(await new GptVision(incomplete.client).send([frame], outputSchema)).toMatchObject({ data: null, error: "status incomplete", input_tokens: 123 });
    const refusal = gpt(openaiResponse("", { output: [{ type: "message", content: [{ type: "refusal", refusal: "No" }] }] }));
    expect(await new GptVision(refusal.client).send([frame], outputSchema)).toMatchObject({ data: null, error: "refusal", output_tokens: 45 });
  });

  it("lets authentication errors stop a run while treating rate limits as failed reads", async () => {
    const auth = gpt({ error: { message: "invalid test key", type: "authentication_error" } }, 401);
    await expect(new GptVision(auth.client).send([frame], outputSchema)).rejects.toBeInstanceOf(OpenAI.AuthenticationError);
    const busy = gpt({ error: { message: "busy", type: "rate_limit_error" } }, 429);
    expect(await new GptVision(busy.client).send([frame], outputSchema)).toMatchObject({ data: null, error: expect.stringContaining("429") });
  });

  it("uses the stable Claude endpoint with supported effort and no fallback beta", async () => {
    const wire = transport({
      id: "msg_test", type: "message", role: "assistant", model: "claude-sonnet-5-5", stop_reason: "end_turn",
      content: [{ type: "text", text: '{"board_visible":true}' }], usage: { input_tokens: 100, output_tokens: 20 },
    });
    const client = new Anthropic({ apiKey: "test-key-not-real", maxRetries: 0, fetch: wire.fetch });
    const vision = new ClaudeVision(client, { effort: "xhigh", myColor: "b" });
    const answer = await vision.send([frame, "Read it"], outputSchema);
    const sent = wire.request();
    expect(String(wire.fetch.mock.calls[0][0])).toContain("/v1/messages");
    expect(sent.model).toBe("claude-sonnet-5-5");
    expect(sent.output_config).toEqual({ effort: "xhigh", format: { type: "json_schema", schema: outputSchema } });
    expect(sent.messages[0].content[0].source).toMatchObject({ type: "base64", media_type: "image/jpeg", data: frame.jpeg.toString("base64") });
    expect(sent).not.toHaveProperty("fallbacks");
    expect(sent).not.toHaveProperty("betas");
    expect(answer).toMatchObject({ error: null, data: { board_visible: true }, input_tokens: 100, output_tokens: 20 });
  });
});

describe("optional Jev image gate", () => {
  async function validFrame(): Promise<Frame> {
    return { jpeg: await sharp({ create: { width: 320, height: 320, channels: 3, background: "white" } }).jpeg().toBuffer(), t: 0 };
  }

  it("sends documented image assets, including the reference when present", async () => {
    const wire = transport({ answers: { readable: { noul: 0.99 }, hand: { noul: 0.01 }, changed: { noul: 0.05 } }, model: JEV_MODEL, usage: { input_tokens: 42 } });
    const client = new TypeSafeClient({ apiKey: "test-key-not-real", fetch: wire.fetch, compression: false, retry: { maxRetries: 0 }, defaultHeaders: { "TypeSafe-Danger-Zone-Images": "true" } });
    const gate = new Gate(client);
    const image = await validFrame();
    const answer = await gate.ask(image, image);
    expect(wire.fetch).toHaveBeenCalledOnce();
    expect(answer).toMatchObject({ readable: 0.99, hand: 0.01, changed: 0.05, model: JEV_MODEL, input_tokens: 42, error: null });
    expect(gate.verdict(answer, { maySkipUnchanged: true })).toBe("unchanged");
    expect(gate.verdict(answer, { maySkipUnchanged: false })).toBe("ask_claude");
    expect(new Headers(wire.fetch.mock.calls[0][1]?.headers).get("TypeSafe-Danger-Zone-Images")).toBe("true");
  });

  it("disables a rejected key after one attempt and always permits vision on failure", async () => {
    const wire = transport({ error: { message: "invalid test key" } }, 401);
    const client = new TypeSafeClient({ apiKey: "test-key-not-real", fetch: wire.fetch, compression: false, retry: { maxRetries: 0 } });
    const gate = new Gate(client);
    const image = await validFrame();
    const answer = await gate.ask(image);
    expect(answer.error).toContain("Jev rejected the key");
    expect(gate.verdict(answer, { maySkipUnchanged: true })).toBe("ask_claude");
    await gate.ask(image);
    expect(wire.fetch).toHaveBeenCalledOnce();
  });

  it("lets malformed gate answers fall through to vision", async () => {
    const client = { systemOne: vi.fn().mockResolvedValue({ answers: { readable: { noul: Number.NaN }, hand: { noul: 0 } }, model: JEV_MODEL, usage: { input_tokens: 1 } }) };
    const gate = new Gate(client);
    const answer = await gate.ask(await validFrame());
    expect(answer.error).toContain("invalid readable probability");
    expect(answer.input_tokens).toBe(1); // a malformed paid response still counts toward spend
    expect(gate.verdict(answer, { maySkipUnchanged: true })).toBe("ask_claude");
  });
});

describe("provider cancellation", () => {
  function pendingTransport() {
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const fetch = vi.fn((_url: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) return reject(new Error("SDK request did not include a cancellation signal"));
      const abort = () => reject(signal.reason);
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
      entered();
    }));
    return { fetch, started };
  }

  it.each(["openai", "anthropic"] as const)("aborts a pending %s SDK request without retrying or producing a failed reading", async (provider) => {
    const wire = pendingTransport();
    const vision = provider === "openai"
      ? new GptVision(new OpenAI({ apiKey: "test-key-not-real", maxRetries: 2, fetch: wire.fetch }), { strategy: "occupancy" })
      : new ClaudeVision(new Anthropic({ apiKey: "test-key-not-real", maxRetries: 2, fetch: wire.fetch }), { strategy: "occupancy" });
    const stop = new AbortController();
    const reason = new Error("test shutdown");
    const rejected = expect(vision.ask(frame, fen, null, stop.signal)).rejects.toBe(reason);
    await wire.started;
    stop.abort(reason);
    await rejected;
    expect(wire.fetch).toHaveBeenCalledOnce();
  });

  it("aborts a pending Jev request instead of falling through to another paid reader", async () => {
    const wire = pendingTransport();
    const client = new TypeSafeClient({ apiKey: "test-key-not-real", fetch: wire.fetch, compression: false, retry: { maxRetries: 2 } });
    const gate = new Gate(client);
    const jpeg = await sharp({ create: { width: 16, height: 16, channels: 3, background: "white" } }).jpeg().toBuffer();
    const stop = new AbortController();
    const reason = new Error("test shutdown");
    const rejected = expect(gate.ask({ jpeg, t: 0 }, null, stop.signal)).rejects.toBe(reason);
    await wire.started;
    stop.abort(reason);
    await rejected;
    expect(wire.fetch).toHaveBeenCalledOnce();
    expect(gate.off).toBeNull();
  });

  it("does not start a request with an already aborted signal", () => {
    const wire = gpt();
    const stop = new AbortController();
    stop.abort(new Error("already stopped"));
    expect(() => new GptVision(wire.client).send([frame], outputSchema, stop.signal)).toThrow("already stopped");
    expect(wire.fetch).not.toHaveBeenCalled();
  });
});

describe("portable configuration", () => {
  it("reads environment keys before consulting Keychain", () => {
    vi.stubEnv("OPENAI_API_KEY", "test-openai-key");
    vi.stubEnv("ANTHROPIC_API_KEY", "test-anthropic-key");
    vi.stubEnv("TYPESAFE_API_KEY", "test-typesafe-key");
    expect(openaiKey()).toBe("test-openai-key");
    expect(anthropicKey()).toBe("test-anthropic-key");
    expect(typesafeKey()).toBe("test-typesafe-key");
    expect(provider("gpt-6.1-sol")).toBe("openai");
    expect(provider("claude-sonnet-5-5")).toBe("anthropic");
    expect(() => provider("invented-provider")).toThrow("Unknown vision provider");
  });

  it("honors an isolated data directory", () => {
    const temp = mkdtempSync(join(tmpdir(), "chesshacker-config-"));
    try {
      vi.stubEnv("CHESSHACKER_DATA_DIR", join(temp, "data"));
      expect(dataDir()).toBe(join(temp, "data"));
    } finally { rmSync(temp, { recursive: true, force: true }); }
  });

  it.skipIf(process.platform === "darwin")("reports missing credentials and macOS hardware without invoking Mac tools", async () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("TYPESAFE_API_KEY", "");
    expect(readSecret("missing-key")).toBeNull();
    expect(() => saveSecret("unused", "test-key-not-real")).toThrow(KeychainError);
    expect(await checkOpenai()).toMatchObject({ ok: false, detail: "none found", fix: expect.stringContaining("OPENAI_API_KEY") });
    expect(await checkAnthropic()).toMatchObject({ ok: false, detail: "none found", optional: true });
    expect(await checkJev()).toMatchObject({ ok: false, optional: true });
    for (const check of [checkMacos, checkWhatsapp, checkBlackhole, checkScreenRecording]) {
      expect(await check()).toMatchObject({ ok: false, detail: expect.stringContaining("macOS") });
    }
  });
});
