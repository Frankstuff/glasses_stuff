import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";

import { Chess } from "chess.js";
import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";

import { boardSvg } from "../src/board-svg.js";
import { type Corners, boardToImage, homography, project, squareCenter, squareOnPlane } from "../src/geometry.js";
import { Locator } from "../src/locate.js";
import { type OverlayState, overlaySvg, renderOverlay } from "../src/overlay.js";
import type { Answer } from "../src/vision.js";

const fen = new Chess().fen();
const corners: Corners = { nearLeft: [0.1, 0.9], nearRight: [0.9, 0.9], farRight: [0.8, 0.2], farLeft: [0.2, 0.2] };
const state: OverlayState = {
  fen, myColor: "w", corners,
  suggestion: { from: "e2", to: "e4", san: "e4", piece: "p" }, status: "Your move",
};

describe("board and overlay rendering", () => {
  it.each(["w", "b"] as const)("renders 64 squares, 32 pieces, coordinates, highlights and arrow for %s", async (orientation) => {
    const svg = boardSvg(fen, { orientation, lastMove: { from: "e2", to: "e4" }, arrow: { from: "e2", to: "e4" } });
    expect(svg.match(/class="square /g)).toHaveLength(64);
    expect(svg.match(/class="piece /g)).toHaveLength(32);
    expect(svg).toContain('class="arrow"');
    expect(svg).toContain('class="square a1" x="' + (orientation === "w" ? '15" y="330"' : '330" y="15"'));
    expect(svg).toMatch(/class="square e2"[^>]*fill="#cdd16a"/);
    expect(svg).toMatch(/class="square e4"[^>]*fill="#cdd16a"/);
    expect(svg).toContain('>a</text>');
    expect(svg).toContain('>8</text>');
    expect(svg).not.toMatch(/NaN|Infinity|\$\{|\{SIZE\}/);
    const { info } = await sharp(Buffer.from(svg)).png().toBuffer({ resolveWithObject: true });
    expect([info.width, info.height]).toEqual([420, 420]);
  });

  it("ignores invalid and zero-length arrows, and escapes attribute text", async () => {
    for (const to of ["e2", "z9"]) {
      const svg = boardSvg(fen, { arrow: { from: "e2", to }, size: NaN });
      expect(svg).not.toContain('class="arrow"');
      expect(svg).not.toMatch(/NaN|Infinity/);
      await sharp(Buffer.from(svg)).png().toBuffer();
    }
    const svg = boardSvg(fen, { arrow: { from: "e2", to: "e4", color: '\"><script>alert(1)</script>' } });
    expect(svg).not.toContain("<script>");
    expect(svg).toContain("&quot;&gt;&lt;script&gt;");
    await sharp(Buffer.from(svg)).png().toBuffer();
  });

  it.each(["w", "b"] as const)("rasterizes the tactical map and perspective overlay for %s", async (myColor) => {
    const position = myColor === "w" ? state : { ...state, fen: fen.replace(" w ", " b "), suggestion: { from: "e7", to: "e5", san: "e5", piece: "p" } };
    const svg = overlaySvg({ ...position, myColor }, 1280, 720);
    expect(svg).toContain("TACTICAL MAP");
    expect(svg).toContain("NEXT MOVE");
    expect(svg).toContain(myColor === "w" ? "1. e4" : "1… e5");
    expect(svg).toContain(myColor === "w" ? "PAWN  e2 → e4" : "PAWN  e7 → e5");
    expect(svg).toContain("<polyline");
    expect(svg).not.toMatch(/NaN|Infinity|\$\{/);
    const background = await sharp({ create: { width: 1280, height: 720, channels: 3, background: "#556677" } }).jpeg().toBuffer();
    const jpeg = await renderOverlay(background, { ...position, myColor });
    const metadata = await sharp(jpeg).metadata();
    expect([metadata.width, metadata.height, metadata.format]).toEqual([1280, 720, "jpeg"]);
    expect(jpeg.equals(background)).toBe(false);
  });

  it("escapes model/status text and renders the map when there is no move", async () => {
    const svg = overlaySvg({ ...state, suggestion: null, corners: null, status: '<script>&"' }, 640, 480);
    expect(svg).toContain("&lt;SCRIPT&gt;&amp;");
    expect(svg).not.toContain("<script>");
    expect(svg).not.toContain("<polyline");
    await sharp(Buffer.from(svg)).png().toBuffer();
    const invalidMove = overlaySvg({ ...state, corners: null, suggestion: { ...state.suggestion!, to: "<bad>" } }, 640, 480);
    expect(invalidMove).toContain("YOUR MOVE");
    expect(invalidMove).not.toContain("NaN");
  });
});

describe("perspective geometry and locator", () => {
  it("maps all four corners and both playing orientations", () => {
    const h = boardToImage(corners);
    for (const [plane, point] of [
      [[0, 0], corners.nearLeft], [[8, 0], corners.nearRight], [[8, 8], corners.farRight], [[0, 8], corners.farLeft],
    ] as const) {
      const actual = project(h, [...plane]);
      expect(actual[0]).toBeCloseTo(point[0]);
      expect(actual[1]).toBeCloseTo(point[1]);
    }
    expect(squareOnPlane("a1", "w")).toEqual([0, 0]);
    expect(squareOnPlane("h8", "b")).toEqual([0, 0]);
    expect(squareCenter(h, "e2", "w")).toEqual(squareCenter(h, "d7", "b"));
    expect(() => squareOnPlane("a9", "w")).toThrow();
  });

  it.each([
    { ...corners, nearLeft: [NaN, 0] },
    { ...corners, farLeft: [Infinity, 0] },
    { ...corners, nearLeft: corners.nearRight },
    { nearLeft: [0, 0], nearRight: [1, 0], farRight: [2, 0], farLeft: [3, 0] },
    { ...corners, farRight: corners.farLeft, farLeft: corners.farRight },
    { ...corners, farLeft: [0.5, 0.5] },
  ] as Corners[])("ignores an unusable quadrilateral without losing the map: %j", async (badCorners) => {
    expect(() => boardToImage(badCorners)).toThrow();
    const svg = overlaySvg({ ...state, corners: badCorners }, 640, 480);
    expect(svg).toEqual(overlaySvg({ ...state, corners: null }, 640, 480));
    await sharp(Buffer.from(svg)).png().toBuffer();
  });

  it("rejects missing points, malformed matrices, and horizon projections", () => {
    expect(() => homography([], [])).toThrow();
    expect(() => project([1, 0, 0, 0, 1, 0, 1, 0, 1], [-1, 0])).toThrow();
    expect(() => project([NaN], [0, 0])).toThrow();
  });

  it("normalizes valid model corners, permits off-frame points, and rejects bad answers", async () => {
    const data = { board_visible: true, near_left: { x: -50, y: 900 }, near_right: { x: 1050, y: 900 }, far_right: { x: 800, y: 200 }, far_left: { x: 200, y: 200 } };
    const answer: Answer = { data, error: null, model: "test", input_tokens: 1, output_tokens: 1, seconds: 0.1 };
    const send = vi.fn().mockResolvedValue(answer);
    const locator = new Locator({ model: "test", send });
    const frame = { jpeg: Buffer.from("frame"), t: 0 };
    expect((await locator.locate(frame)).corners?.nearLeft).toEqual([-0.05, 0.9]);
    expect(send.mock.calls[0][0][0]).toBe(frame);
    for (const changed of [
      { data: null }, { error: "failed" }, { data: { ...data, board_visible: false } },
      { data: { ...data, near_left: undefined } }, { data: { ...data, near_left: { x: NaN, y: 10 } } },
      { data: { ...data, near_left: data.near_right } },
    ]) {
      send.mockResolvedValueOnce({ ...answer, ...changed });
      expect((await locator.locate(frame)).corners).toBeNull();
    }
  });
});

/** Minimal DOM boundary for running the actual page script, with active HTML sinks forbidden. */
class Element {
  children: Element[] = [];
  parent: Element | null = null;
  private content = "";
  className = "";
  value = "";
  src = "";
  alt = "";
  style: Record<string, string> = {};
  scrollHeight = 0;
  scrollTop = 0;
  clientHeight = 0;
  onclick: () => unknown = () => undefined;
  onkeydown: (event: { key: string }) => unknown = () => undefined;
  constructor(readonly tagName: string) {}
  set innerHTML(_: string) { throw new Error("unsafe HTML sink"); }
  set textContent(value: unknown) { this.content = String(value); this.children = []; }
  get textContent(): string { return this.content + this.children.map((child) => child.textContent).join(""); }
  get childElementCount() { return this.children.length; }
  get firstChild() { return this.children[0]; }
  appendChild(child: Element) { child.parent = this; this.children.push(child); return child; }
  replaceChildren(...children: Element[]) { this.content = ""; this.children = []; children.forEach((child) => this.appendChild(child)); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter((child) => child !== this); }
}

function page() {
  const html = readFileSync(new URL("../src/static/index.html", import.meta.url), "utf8");
  const nodes = new Map([...html.matchAll(/id="([^"]+)"/g)].map((match) => [match[1], new Element("div")]));
  const get = (id: string) => nodes.get(id)!;
  get("filter").value = "all";
  get("color").value = "white";
  let source!: { onmessage: (message: { data: string }) => unknown; onerror: () => void };
  const fetch = vi.fn().mockResolvedValue({ headers: { get: () => "application/json" }, json: async () => ({ ok: true }) });
  const alert = vi.fn();
  const context = createContext({
    document: { getElementById: get, createElement: (tag: string) => new Element(tag) }, fetch, alert,
    EventSource: class { constructor() { source = this as unknown as typeof source; } },
  });
  runInContext(html.match(/<script>([\s\S]*?)<\/script>/)![1], context);
  const emit = (event: Record<string, unknown>) => source.onmessage({ data: JSON.stringify(event) });
  return { get, source, emit, fetch, alert };
}

describe("recovered browser script", () => {
  const snapshot = {
    kind: "state", status: "Your move", my_color: "white", turn: "white", model: "test-model", strategy: "changes", gate: true,
    spent: 1.234, max_cost: 10, board_svg: boardSvg(fen), paused: false, frame_t: 1.2, moves: "1. e4",
    suggestion: { spoken: "Pawn to e4", san: "e4", score: "+0.3", bar: 0.7 },
  };

  it("renders the state, badges and event descriptions with safe text", () => {
    const { get, emit, source } = page();
    emit({ ...snapshot, suggestion: { ...snapshot.suggestion, spoken: '<img src=x onerror="alert(1)">' } });
    expect(get("status").className).toBe("pill go");
    expect(get("setup").textContent).toBe("test-model · changes · Jev pre-check");
    expect(get("spend").textContent).toBe("$1.23 of $10.00");
    expect(get("say").textContent).toContain('<img src=x onerror="alert(1)">');
    expect(get("say").children[0].tagName).toBe("small");
    expect(get("board").children[0].src).toBe("data:image/svg+xml;charset=utf-8," + encodeURIComponent(snapshot.board_svg));
    expect(get("bar").style.width).toBe("70.0%");
    expect(get("frame").src).toMatch(/^\/frame.jpg\?t=/);
    emit({ kind: "frame", t: 1, frame_t: 2, verdict: "ask_claude", update: "seen", move: "e4", margin: 3, jev: { readable: 0.9, hand: 0.01, changed: 0.8 }, vision: { seconds: 0.5 } });
    expect(get("badges").children.map((child) => child.textContent)).toEqual(["t=2s", "read by model", "readable 90%", "hand 1%", "changed 80%", "model 0.5s", "margin 3"]);
    expect(get("log").textContent).toContain("frame 2s  saw e4  margin 3");
    emit({ kind: "commit", t: 2, san: "e4", by: "white", suggested: "d4" });
    expect(get("log").textContent).toContain("COMMIT e4 by white (suggested d4)");
    emit({ kind: "control", t: 3, action: "move", move: "<script>" });
    expect(get("log").textContent).toContain("control: move <script>");
    emit({ ...snapshot, suggestion: null, paused: true, status: "Paused" });
    expect(get("say").textContent).toBe("");
    expect(get("bar").style.width).toBe("50.0%");
    expect(get("pause").textContent).toBe("Resume");
    source.onerror();
    expect(get("status").textContent).toBe("Disconnected");
    expect(() => source.onmessage({ data: "not JSON" })).not.toThrow();
  });

  it("keeps the log bounded and honors the console filter", () => {
    const { emit, get } = page();
    get("filter").value = "moves";
    emit({ kind: "frame" });
    expect(get("log").children).toHaveLength(0);
    emit({ kind: "suggest", spoken: "Pawn to e4", san: "e4", score: "+0.3" });
    expect(get("log").textContent).toContain('SAY "Pawn to e4"  e4 +0.3');
    get("filter").value = "problems";
    emit({ kind: "ready" });
    expect(get("log").children).toHaveLength(1);
    for (let i = 0; i < 510; i++) emit({ kind: "error", t: i, detail: `<bad ${i}>` });
    expect(get("log").children).toHaveLength(500);
    expect(get("log").children.at(-1)?.textContent).toContain("<bad 509>");
  });

  it("wires every control to JSON and reports network/server failures", async () => {
    const { emit, get, fetch, alert } = page();
    emit(snapshot);
    await get("pause").onclick();
    await get("undo").onclick();
    await get("repeat").onclick();
    get("move").value = " Nf3 ";
    get("move").onkeydown({ key: "Enter" });
    get("color").value = "black";
    get("fen").value = " " + fen + " ";
    await get("new").onclick();
    expect(fetch.mock.calls.map((call) => JSON.parse(call[1].body))).toEqual([
      { action: "pause" }, { action: "undo" }, { action: "repeat" }, { action: "move", move: "Nf3" }, { action: "new_game", color: "black", fen },
    ]);
    expect(fetch.mock.calls[0][1].headers["Content-Type"]).toBe("application/json");
    fetch.mockRejectedValueOnce(new Error("offline"));
    await get("undo").onclick();
    expect(alert).toHaveBeenLastCalledWith("Control failed: offline");
    fetch.mockResolvedValueOnce({ status: 403, headers: { get: () => "text/plain" }, text: async () => "forbidden" });
    await get("undo").onclick();
    expect(alert).toHaveBeenLastCalledWith("Control failed: forbidden");
    fetch.mockResolvedValueOnce({ headers: { get: () => "application/json" }, json: async () => ({ ok: false, error: "illegal move" }) });
    await get("undo").onclick();
    expect(alert).toHaveBeenLastCalledWith("illegal move");
  });
});
