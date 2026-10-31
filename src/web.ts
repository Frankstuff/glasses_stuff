/**
 * The command center: a local web page showing the game live, with a few controls.
 *
 * GET /          the page
 * GET /events    Server-Sent Events: the current state, recent events, then everything new
 * GET /frame.jpg the latest frame from the call
 * GET /overlay   the video with the overlay, filling the window: an OBS Browser Source
 * GET /overlay.mjpg  the same video as MJPEG
 * POST /control  {"action": ...}: pause, resume, undo, move, new_game, repeat
 *
 * State and events go to the page with snake_case keys (my_color, board_svg, …), as the page
 * expects.
 */

import { readFileSync } from "node:fs";
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";

import type { Frame } from "./capture.js";
import type { Events, GameEvent } from "./events.js";

export const HOST = "127.0.0.1"; // only this Mac: the page can enter moves
export const PORTS = { from: 8000, to: 8010 };
export const MAX_CONTROL_BYTES = 16 * 1024;

export interface Center {
  latestFrame: Frame | null;
  events: Events;
  snapshot(): Record<string, unknown>;
  control(request: Record<string, unknown>): string | null;
}

/** Something that sends out overlay frames: the OverlayFeed. */
export interface Overlay {
  subscribe(viewer: (jpeg: Buffer) => void): () => void;
}

const PAGE = new URL("./static/index.html", import.meta.url);
const OVERLAY_PAGE =
  '<!doctype html><html><head><meta charset="utf-8"><title>chesshacker overlay</title><style>' +
  "html,body{margin:0;height:100%;background:#000;overflow:hidden}" +
  "img{display:block;width:100%;height:100%;object-fit:contain}" +
  '</style></head><body><img src="/overlay.mjpg" alt=""></body></html>';

/** Start the command center on the first free port from `ports.from` to `ports.to`. */
export async function serve(
  center: Center,
  { host = HOST, ports = PORTS, overlay = null as Overlay | null } = {},
): Promise<{ server: Server; url: string }> {
  if (host === "localhost") host = HOST;
  if (host !== HOST && host !== "::1") throw new Error("the command center must bind to loopback");
  if (!Number.isInteger(ports.from) || !Number.isInteger(ports.to) || ports.from < 0 || ports.to > 65535 || ports.to < ports.from) {
    throw new Error("invalid port range");
  }
  const page = readFileSync(PAGE);
  for (let port = ports.from; port <= ports.to; port++) {
    const server = createServer((request, response) => {
      request.on("error", () => { if (!response.writableEnded) response.destroy(); });
      response.on("error", () => response.destroy());
      try {
        handle(center, overlay, page, request, response);
      } catch {
        if (response.headersSent) response.destroy();
        else send(response, 500, "text/plain", "request failed");
      }
    });
    server.requestTimeout = 15_000;
    const listening = await new Promise<boolean>((resolve) => {
      const failed = () => resolve(false);
      server.once("error", failed);
      server.listen(port, host, () => {
        server.removeListener("error", failed);
        resolve(true);
      });
    });
    if (listening) {
      const address = server.address();
      const actual = typeof address === "object" && address ? address.port : port;
      return { server, url: `http://${host === "::1" ? "[::1]" : host}:${actual}` };
    }
  }
  throw new Error(`no free port from ${ports.from} to ${ports.to}`);
}

function handle(center: Center, overlay: Overlay | null, page: Buffer, request: IncomingMessage, response: ServerResponse): void {
  // Check Host as well as Origin: an arbitrary hostname pointing at loopback must not
  // gain access to the local game through DNS rebinding.
  if (!localHost(request)) return send(response, 403, "text/plain", "forbidden");
  const path = (request.url ?? "/").split("?")[0];
  if (request.method === "GET" && path === "/") return send(response, 200, "text/html; charset=utf-8", page);
  if (request.method === "GET" && path === "/overlay") return send(response, 200, "text/html; charset=utf-8", OVERLAY_PAGE);
  if (request.method === "GET" && path === "/overlay.mjpg") {
    return overlay ? mjpeg(overlay, request, response) : send(response, 404, "text/plain", "no overlay");
  }
  if (request.method === "GET" && path === "/frame.jpg") {
    const frame = center.latestFrame;
    return frame ? send(response, 200, "image/jpeg", frame.jpeg) : send(response, 404, "text/plain", "no frame yet");
  }
  if (request.method === "GET" && path === "/events") return stream(center, request, response);
  if (request.method === "POST" && path === "/control") {
    void control(center, request, response).catch(() => {
      if (response.headersSent) response.destroy();
      else if (!response.destroyed) send(response, 500, "application/json", JSON.stringify({ ok: false, error: "control failed" }));
    });
    return;
  }
  send(response, 404, "text/plain", "not found");
}

async function control(center: Center, request: IncomingMessage, response: ServerResponse): Promise<void> {
  // Only this page's own JSON requests: a JSON content type makes browsers check with the server
  // before another site's page could send one, and this server never agrees.
  const origin = request.headers.origin;
  const contentType = request.headers["content-type"]?.split(";")[0].trim().toLowerCase();
  if (contentType !== "application/json" || (origin !== undefined && origin !== `http://${request.headers.host}`) ||
      request.headers["sec-fetch-site"] === "cross-site") {
    request.resume();
    return send(response, 403, "text/plain", "forbidden");
  }
  let raw: string;
  try {
    raw = await controlBody(request);
  } catch (error) {
    if (!response.destroyed) send(response, error === "too large" ? 413 : 400, "application/json", JSON.stringify({ ok: false, error: error === "too large" ? "request body too large" : "could not read request" }));
    return;
  }
  let body: unknown;
  try {
    body = JSON.parse(raw || "null");
  } catch {
    return send(response, 400, "application/json", JSON.stringify({ ok: false, error: "expected JSON" }));
  }
  let error: string | null;
  try {
    error = body && typeof body === "object" && !Array.isArray(body) ? center.control(body as Record<string, unknown>) : "expected an object";
  } catch {
    return send(response, 500, "application/json", JSON.stringify({ ok: false, error: "control failed" }));
  }
  send(response, error === null ? 200 : 400, "application/json", JSON.stringify({ ok: error === null, error }));
}

function localHost(request: IncomingMessage): boolean {
  const host = request.headers.host;
  if (!host) return false;
  const match = /^(127\.0\.0\.1|localhost|\[::1\]):(\d+)$/.exec(host);
  return Boolean(match && Number(match[2]) === request.socket.localPort);
}

/** Read at most one small command, including when it arrives without Content-Length. */
function controlBody(request: IncomingMessage): Promise<string> {
  if (Number(request.headers["content-length"] ?? 0) > MAX_CONTROL_BYTES) {
    request.resume();
    return Promise.reject("too large");
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    const cleanup = () => {
      request.removeListener("data", data);
      request.removeListener("end", end);
      request.removeListener("aborted", aborted);
      request.removeListener("error", failed);
    };
    const failed = (error: unknown) => { cleanup(); reject(error); };
    const aborted = () => failed(new Error("request aborted"));
    const data = (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_CONTROL_BYTES) {
        failed("too large");
        request.resume(); // discard the rest without keeping it in memory
      } else chunks.push(chunk);
    };
    const end = () => { cleanup(); resolve(Buffer.concat(chunks).toString("utf8")); };
    request.on("data", data);
    request.once("end", end);
    request.once("aborted", aborted);
    request.once("error", failed);
  });
}

function stream(center: Center, request: IncomingMessage, response: ServerResponse): void {
  response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
  const write = (event: GameEvent) => {
    if (response.destroyed) return;
    // Allow the initial recent-events burst, but disconnect a viewer that keeps falling behind.
    if (response.writableLength > 1024 * 1024) response.destroy();
    else response.write(`data: ${JSON.stringify(event)}\n\n`);
  };
  write({ kind: "state", ...center.snapshot() });
  const { recent, unsubscribe } = center.events.subscribe(write);
  for (const event of recent) write(event);
  const keepAlive = setInterval(() => response.write(": still here\n\n"), 15_000);
  response.on("close", () => {
    clearInterval(keepAlive);
    unsubscribe();
  });
}

/** Overlay frames as they're made, as a multipart MJPEG stream. A slow viewer misses frames. */
function mjpeg(overlay: Overlay, request: IncomingMessage, response: ServerResponse): void {
  response.writeHead(200, { "Content-Type": "multipart/x-mixed-replace; boundary=frame", "Cache-Control": "no-store" });
  const unsubscribe = overlay.subscribe((jpeg) => {
    if (response.writableNeedDrain) return;
    response.write(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpeg.length}\r\n\r\n`);
    response.write(jpeg);
    response.write("\r\n");
  });
  response.on("close", unsubscribe);
}

function send(response: ServerResponse, status: number, contentType: string, body: Buffer | string): void {
  response.writeHead(status, {
    "Content-Type": contentType,
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  response.end(body);
}
