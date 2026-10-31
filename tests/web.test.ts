import { once } from "node:events";
import { type Server, request as httpRequest } from "node:http";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Events } from "../src/events.js";
import { type Center, MAX_CONTROL_BYTES, serve } from "../src/web.js";

describe("local command center", () => {
  let center: Center;
  let server: Server;
  let url: string;

  beforeEach(async () => {
    center = {
      latestFrame: null, events: new Events(), snapshot: () => ({ status: "Paused", paused: true }),
      control: vi.fn((body) => body.action === "pause" ? null : "unknown action"),
    };
    ({ server, url } = await serve(center, { ports: { from: 0, to: 0 } }));
  });

  afterEach(async () => {
    vi.useRealTimers();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const post = (base: string, body: string, headers: Record<string, string> = {}) => fetch(base + "/control", {
    method: "POST", body, headers: { "Content-Type": "application/json", ...headers },
  });

  it("binds to loopback, returns the actual port, and serves the original page/frame routes", async () => {
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(server.address()).toMatchObject({ address: "127.0.0.1" });
    const response = await fetch(url);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(await response.text()).toContain("Live frame");
    expect((await fetch(url + "/frame.jpg")).status).toBe(404);
    center.latestFrame = { jpeg: Buffer.from([0xff, 0xd8, 0xff, 0xd9]), t: 1 };
    const frame = await fetch(url + "/frame.jpg?t=1");
    expect(frame.headers.get("content-type")).toBe("image/jpeg");
    expect(Buffer.from(await frame.arrayBuffer())).toEqual(center.latestFrame.jpeg);
    expect(await (await fetch(url + "/overlay")).text()).toContain('/overlay.mjpg');
    expect((await fetch(url + "/overlay.mjpg")).status).toBe(404);
    expect((await fetch(url + "/missing")).status).toBe(404);
    await expect(serve(center, { host: "0.0.0.0", ports: { from: 0, to: 0 } })).rejects.toThrow("loopback");
  });

  it("accepts same-origin JSON and local scripts while rejecting cross-site controls", async () => {
    const ok = await post(url, '{"action":"pause"}', { Origin: url });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true, error: null });
    expect((await post(url, '{"action":"pause"}', { "Content-Type": "application/json; charset=utf-8" })).status).toBe(200);
    const rejected: Record<string, string>[] = [
      { Origin: "https://example.com" }, { Origin: "null" }, { Origin: url + ".evil" },
      { Origin: url, "Content-Type": "text/plain" }, { Origin: url, "Sec-Fetch-Site": "cross-site" },
    ];
    for (const headers of rejected) {
      const result = await post(url, '{"action":"pause"}', headers);
      expect(result.status).toBe(403);
      expect(result.headers.get("access-control-allow-origin")).toBeNull();
    }
    const preflight = await fetch(url + "/control", { method: "OPTIONS", headers: { Origin: "https://example.com", "Access-Control-Request-Method": "POST" } });
    expect(preflight.headers.get("access-control-allow-origin")).toBeNull();
    expect(center.control).toHaveBeenCalledTimes(2);
  });

  it("rejects a forged hostname even when Origin matches it", async () => {
    const port = new URL(url).port;
    const response = await new Promise<{ status: number; text: string }>((resolve, reject) => {
      const request = httpRequest(url + "/control", { method: "POST", headers: { Host: `attacker.test:${port}`, Origin: `http://attacker.test:${port}`, "Content-Type": "application/json" } }, (response) => {
        let text = "";
        response.on("data", (chunk) => { text += String(chunk); });
        response.on("end", () => resolve({ status: response.statusCode!, text }));
      });
      request.on("error", reject);
      request.end('{"action":"pause"}');
    });
    expect(response.status).toBe(403);
    expect(center.control).not.toHaveBeenCalled();
  });

  it("rejects malformed bodies and distinguishes handler failures", async () => {
    for (const [body, error] of [["{", "expected JSON"], ["null", "expected an object"], ["[]", "expected an object"], ["1", "expected an object"], ['{"action":"bad"}', "unknown action"]]) {
      const response = await post(url, body);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ ok: false, error });
    }
    vi.mocked(center.control).mockImplementationOnce(() => { throw new Error("private details"); });
    const response = await post(url, '{"action":"pause"}');
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ ok: false, error: "control failed" });
    expect((await post(url, '{"action":"pause"}')).status).toBe(200);
  });

  it("bounds both Content-Length and chunked control bodies at 16 KiB", async () => {
    const empty = JSON.stringify({ action: "pause", padding: "" });
    const exact = JSON.stringify({ action: "pause", padding: "x".repeat(MAX_CONTROL_BYTES - Buffer.byteLength(empty)) });
    expect(Buffer.byteLength(exact)).toBe(MAX_CONTROL_BYTES);
    expect((await post(url, exact)).status).toBe(200);
    expect((await post(url, exact + " ")).status).toBe(413);
    const result = await new Promise<number>((resolve, reject) => {
      const request = httpRequest(url + "/control", { method: "POST", headers: { "Content-Type": "application/json", "Transfer-Encoding": "chunked" } }, (response) => {
        response.resume();
        response.once("end", () => resolve(response.statusCode!));
      });
      request.once("error", reject);
      request.write(exact.slice(0, 100));
      request.write(exact.slice(100));
      request.end(" ");
    });
    expect(result).toBe(413);
    expect(center.control).toHaveBeenCalledTimes(1);
  });

  it("survives an aborted request without applying a partial control", async () => {
    const seen = once(server, "request");
    const request = httpRequest(url + "/control", { method: "POST", headers: { "Content-Type": "application/json", "Content-Length": "1000" } });
    request.on("error", () => undefined);
    request.write('{"action":');
    await seen;
    request.destroy();
    expect((await post(url, '{"action":"pause"}')).status).toBe(200);
    expect(center.control).toHaveBeenCalledTimes(1);
  });

  it("streams state, recent and live events, heartbeats, and cleans up on disconnect", async () => {
    center.events.emit("ready", { my_color: "white" });
    const original = center.events.subscribe.bind(center.events);
    const unsubscribe = vi.fn();
    vi.spyOn(center.events, "subscribe").mockImplementation((listener) => {
      const result = original(listener);
      return { ...result, unsubscribe: () => { unsubscribe(); result.unsubscribe(); } };
    });
    const response = await fetch(url + "/events");
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    while (!text.includes('"kind":"ready"')) text += decoder.decode((await reader.read()).value);
    const events = text.split("\n\n").filter(Boolean).map((line) => JSON.parse(line.slice(6)));
    expect(events[0]).toEqual({ kind: "state", status: "Paused", paused: true });
    expect(events[1]).toMatchObject({ kind: "ready", my_color: "white" });
    center.events.emit("commit", { san: "e4", detail: "line1\nline2" });
    const live = decoder.decode((await reader.read()).value);
    expect(JSON.parse(live.slice(6))).toMatchObject({ kind: "commit", san: "e4", detail: "line1\nline2" });
    await reader.cancel();
    await vi.waitFor(() => expect(unsubscribe).toHaveBeenCalledOnce());

    // Exercise heartbeats without delaying the suite by 15 seconds.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const heartbeatResponse = await fetch(url + "/events");
    const heartbeatReader = heartbeatResponse.body!.getReader();
    await heartbeatReader.read();
    vi.advanceTimersByTime(15_000);
    expect(decoder.decode((await heartbeatReader.read()).value)).toBe(": still here\n\n");
    await heartbeatReader.cancel();
  });

  it("sends multipart JPEG frames and unsubscribes overlay viewers", async () => {
    let viewer!: (jpeg: Buffer) => void;
    const unsubscribe = vi.fn();
    const subscribe = vi.fn((callback: (jpeg: Buffer) => void) => { viewer = callback; return unsubscribe; });
    const overlayServer = await serve(center, { ports: { from: 0, to: 0 }, overlay: { subscribe } });
    try {
      const pending = fetch(overlayServer.url + "/overlay.mjpg");
      await vi.waitFor(() => expect(subscribe).toHaveBeenCalledOnce());
      const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
      viewer(jpeg);
      const response = await pending;
      expect(response.headers.get("content-type")).toBe("multipart/x-mixed-replace; boundary=frame");
      const reader = response.body!.getReader();
      const part = Buffer.from((await reader.read()).value!);
      expect(part.subarray(0, -6).toString()).toBe("--frame\r\nContent-Type: image/jpeg\r\nContent-Length: 4\r\n\r\n");
      expect(part.subarray(-6, -2)).toEqual(jpeg);
      await reader.cancel();
      await vi.waitFor(() => expect(unsubscribe).toHaveBeenCalledOnce());
    } finally {
      overlayServer.server.closeAllConnections();
      await new Promise<void>((resolve) => overlayServer.server.close(() => resolve()));
    }
  });
});
