/** The `chesshacker` command. */

import { spawn } from "node:child_process";
import type { Server } from "node:http";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";

import { Chess } from "chess.js";
import { Command, InvalidArgumentError, Option } from "commander";
import sharp from "sharp";

import { CallWindow, Replay, type Source, toJpeg } from "./capture.js";
import * as config from "./config.js";
import * as doctor from "./doctor.js";
import { STOCKFISH_VERSION, SteadyEngine, downloadStockfish, findStockfish, installedPath } from "./engine.js";
import { Events } from "./events.js";
import { demo } from "./demo.js";
import { OverlayFeed } from "./feed.js";
import { Gate } from "./gate.js";
import { Locator } from "./locate.js";
import * as macos from "./macos.js";
import { Game } from "./main.js";
import { price } from "./pricing.js";
import { BLACKHOLE, Speaker, type Target } from "./speak.js";
import { STRATEGIES, type Strategy, makeVision } from "./vision.js";
import { serve } from "./web.js";

const interactive = () => Boolean(process.stdin.isTTY);

/** Install what's missing, ask for keys, then run every doctor check. */
async function setup(options: { engineOnly?: boolean } = {}): Promise<number> {
  if (!options.engineOnly && process.platform !== "darwin") {
    return failed("Live glasses setup requires macOS.", "Use `node dist/bin.js setup --engine-only` and `npm run demo` for the offline demonstration on Linux.");
  }
  const path = findStockfish();
  if (path === null || (path === installedPath() && !(await doctor.checkStockfish()).ok)) {
    console.log(`Downloading Stockfish ${STOCKFISH_VERSION} (about 80 MB)…`);
    await downloadStockfish(progress());
    console.log();
  }
  if (options.engineOnly) return doctor.run([doctor.checkStockfish]);
  const gpt = config.provider(config.visionModel()) === "openai";
  const keys: [(key?: string) => Promise<doctor.Check>, (key: string) => void, string][] = [
    [doctor.checkOpenai, config.saveOpenaiKey, `An OpenAI API key (platform.openai.com)${gpt ? " reads the board." : ", optional."}`],
    [
      doctor.checkAnthropic,
      config.saveAnthropicKey,
      `An Anthropic API key (console.anthropic.com)${gpt ? ", optional." : " reads the board."}`,
    ],
    [
      doctor.checkJev,
      config.saveTypesafeKey,
      "Optional: a Jev key (console.typesafe.ai) skips frames that don't need the vision model, which makes games cheaper.",
    ],
  ];
  for (const [check, save, intro] of keys) {
    if (!(await check()).ok) await askForKey(intro, check, save);
  }
  if (!(await macos.screenRecordingAllowed()) && interactive()) {
    console.log(
      `chesshacker needs Screen Recording permission for ${macos.terminalApp()} to see the call. ` +
        "Opening the setting: turn it on, then quit and reopen the app.\n",
    );
    await macos.askForScreenRecording();
  }
  console.log();
  return doctor.run();
}

async function askForKey(intro: string, check: (key?: string) => Promise<doctor.Check>, save: (key: string) => void): Promise<void> {
  if (!interactive()) return; // doctor's report says what's missing and how to add it
  console.log(intro);
  for (let attempt = 0; attempt < 3; attempt++) {
    const key = await askSecret("Paste it here (it won't show; Enter to skip): ");
    if (!key) return;
    const result = await check(key);
    if (result.ok) {
      save(key);
      console.log("  Saved to your Keychain.\n");
      return;
    }
    console.log(`  That didn't work: ${result.detail}.`);
  }
}

/** Read a line from the terminal without echoing it. */
function askSecret(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const input = process.stdin;
    let secret = "";
    const finish = (error?: Error) => {
      input.off("data", onData);
      input.setRawMode(false);
      input.pause();
      process.stdout.write("\n");
      if (error) reject(error);
      else resolve(secret.trim());
    };
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === "\r" || char === "\n") return finish();
        if (char === "\u0003") return finish(new Error("cancelled")); // Ctrl-C
        if (char === "\u007f" || char === "\b") secret = secret.slice(0, -1);
        else if (char >= " ") secret += char;
      }
    };
    process.stdout.write(prompt);
    input.setEncoding("utf8");
    input.setRawMode(true);
    input.resume();
    input.on("data", onData);
  });
}

async function ask(question: string): Promise<string> {
  const reader = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await reader.question(question);
  } finally {
    reader.close();
  }
}

/** A download progress callback that prints the percentage when it changes. */
function progress(): (done: number, total: number) => void {
  let shown = -1;
  return (done, total) => {
    const percent = total > 0 ? Math.min(100, Math.floor((done * 100) / total)) : -1;
    if (percent !== shown && process.stdout.isTTY) process.stdout.write(`\r  ${percent}%`);
    shown = percent;
  };
}

interface RunOptions {
  color: "white" | "black";
  fen?: string;
  model: string;
  strategy: Strategy;
  gate: boolean;
  speak: Target;
  video?: string;
  speed: number;
  exitAtEnd?: boolean;
  window?: number;
  every: number;
  maxCost: number;
  browser: boolean;
  overlayOut?: string;
  overlayFps: number;
  locateEvery: number;
  locateModel?: string;
  maxAdviceAge: number;
}

/** Play: watch the call (or a recording), speak the best moves, serve the command center. */
async function play(options: RunOptions): Promise<number> {
  if (process.platform !== "darwin" && (!options.video || options.speak !== "none")) {
    return failed("Live capture and speech require macOS.", "On Linux use --video FILE --speak none --no-browser, or run `npm run demo`.");
  }
  for (const model of [options.model, options.locateModel ?? options.model]) {
    if (price(model) === null) {
      console.error(`Unknown model ${model}: no price for it, so the spending cap can't work.`);
      return 1;
    }
  }
  if (options.video && !existsSync(options.video)) {
    console.error(`No such file: ${options.video}`);
    return 1;
  }
  const checks: doctor.CheckFn[] = [doctor.checkStockfish, () => doctor.checkVisionKey(options.model)];
  if (!options.video) checks.push(doctor.checkWhatsapp, doctor.checkScreenRecording);
  if (options.speak === "call") checks.push(doctor.checkBlackhole);
  const gateCheck = options.gate ? await doctor.checkJev() : { ok: false, detail: "disabled" };
  if (options.gate && !gateCheck.ok) console.log(`Jev pre-check off: ${gateCheck.detail}.`);
  if (await doctor.run(checks)) return 1;
  let start: Chess;
  try {
    start = new Chess(options.fen);
  } catch (error) {
    console.error(`Bad --fen: ${(error as Error).message}`);
    return 1;
  }

  let source: Source & { close?: () => void };
  try {
    source = options.video ? await Replay.open(options.video, options.speed) : new CallWindow(options.window);
  } catch (error) {
    console.error((error as Error).message);
    return 1;
  }
  if (!options.video) macos.keepAwake();

  const color = options.color === "white" ? "w" : "b";
  const runDir = join(config.dataDir(), "runs", timestamp());
  mkdirSync(runDir, { recursive: true });
  const events = new Events(join(runDir, "events.jsonl"));
  const speaker = new Speaker(options.speak, {
    onSpoken: (text) => events.emit("spoken", { detail: text }),
    onFailed: (text) =>
      events.emit("error", {
        detail: `couldn't say ${JSON.stringify(text)}${options.speak === "call" ? ` (is ${BLACKHOLE} still installed?)` : ""}`,
      }),
  });
  const gate = options.gate && gateCheck.ok ? new Gate(config.typesafeClient()) : null;

  let engine: SteadyEngine | null = null;
  let server: Server | null = null;
  try {
    engine = await SteadyEngine.start();
    const game = new Game(source, {
      vision: makeVision(options.model, { strategy: options.strategy, myColor: color }),
      // the changes strategy compares two frames, so a frame with nothing to compare is read alone
      firstLook: options.strategy === "changes" ? makeVision(options.model, { strategy: "occupancy", myColor: color }) : null,
      engine,
      speaker,
      events,
      myColor: color,
      start,
      gate,
      maxCost: options.maxCost,
      runDir,
      pace: { opponent: options.every, mine: Math.max(options.every, 3.0) },
      exitAtEnd: options.exitAtEnd,
      maxAdviceAge: options.maxAdviceAge,
    });
    const locator = new Locator(makeVision(options.locateModel ?? options.model, { myColor: color }));
    const feed = new OverlayFeed(source, game, locator, {
      fps: options.overlayFps,
      locateEvery: options.locateEvery,
      out: options.overlayOut ?? null,
      speed: options.video ? options.speed : 1,
    });
    let url: string;
    try {
      ({ server, url } = await serve(game, { overlay: feed }));
    } catch (error) {
      console.error(`Couldn't start the command center: ${(error as Error).message}.`);
      return 1;
    }
    console.log(`\nCommand center: ${url}\nOverlay video (an OBS Browser Source): ${url}/overlay\nLogs: ${runDir}\nPress Ctrl-C to stop.\n`);
    if (options.overlayOut) console.log(`Overlay video going to ${options.overlayOut}\n`);
    if (options.browser && process.platform === "darwin") spawn("open", [url], { stdio: "ignore" }).on("error", () => undefined);
    const stop = new AbortController();
    const stopFeed = new AbortController();
    const stopping = () => {
      stop.abort();
      stopFeed.abort();
      speaker.clear();
      source.close?.();
      engine?.close();
    };
    process.once("SIGINT", stopping);
    process.once("SIGTERM", stopping);
    // the feed reports its own failures; this only keeps an unexpected one from ending the game
    const feeding = feed.run(stopFeed.signal).catch((error: unknown) => game.overlayError(String(error)));
    try {
      await game.run(stop.signal);
    } finally {
      stopFeed.abort();
      process.off("SIGINT", stopping);
      process.off("SIGTERM", stopping);
      await feeding; // finishes the --overlay-out file
      await speaker.wait();
    }
    console.log(`\nStopped. Spent $${game.spent.toFixed(2)}. Game and logs: ${runDir}`);
    return 0;
  } finally {
    server?.closeAllConnections();
    server?.close();
    engine?.close();
    source.close?.();
  }
}

/** Check a real call end to end: the call window, a frame of the board, speech into the call. */
async function testCall(options: { window?: number }): Promise<number> {
  if (process.platform !== "darwin") return failed("test-call needs macOS.", "Run this command in Terminal on your Mac.");
  if (!interactive()) {
    console.error("test-call asks you questions: run it in a terminal.");
    return 1;
  }
  const checks = [() => doctor.checkVisionKey(), doctor.checkWhatsapp, doctor.checkScreenRecording, doctor.checkBlackhole];
  if (await doctor.run(checks)) return 1;

  console.log("\n1. From the glasses, video-call this Mac's WhatsApp and answer the call here.");
  process.stdout.write("   Waiting for the call window");
  // never WhatsApp's main window (see pickCallWindow): wait for the call's own window to appear
  const big = (w: macos.Window | null): w is macos.Window => w !== null && w.width * w.height > 200 * 200;
  let window: macos.Window | null = null;
  for (let i = 0; i < 120 && !big(window); i++) {
    if (i) await new Promise((resolve) => setTimeout(resolve, 1000));
    window = await macos.callWindow(options.window);
    if (!big(window)) process.stdout.write(".");
  }
  console.log();
  if (!big(window)) {
    return failed(
      "No WhatsApp call window showed up.",
      "Answer the call on this Mac and keep its window open (not minimized). If the call shows inside WhatsApp's main window, `npx chesshacker windows` lists the windows; pass the right one with --window.",
    );
  }
  console.log(`   ✓ found it: window ${window.id}, ${window.width}×${window.height}`);

  await ask("\n2. Double-tap the glasses' capture button to share their view, look at the board, then press Enter.");
  const call = await macos.callWindow(options.window); // look again: the window may have changed since
  if (call === null) return failed("The call window went away.", "Keep the call open on this Mac, then try again.");
  const data = await macos.capture(call.id);
  if (data === null) return failed("Couldn't capture the call window.", "Keep it open and visible, then try again.");
  const { channels } = await sharp(data).greyscale().stats();
  if (channels[0].mean < 8) {
    return failed("The captured frame is black.", `Check Screen Recording for ${macos.terminalApp()} and that the call shows video.`);
  }
  const snapshot = join(config.dataDir(), "test-call.jpg");
  const jpeg = await toJpeg(data);
  writeFileSync(snapshot, jpeg);
  spawn("open", [snapshot], { stdio: "ignore" });
  const vision = makeVision(config.visionModel(), { strategy: "occupancy" });
  const frame = { jpeg, t: 0 };
  const fen = new Chess().fen();
  if (!vision.reading(await vision.ask(frame, fen, frame), fen).boardVisible) {
    return failed(
      "The vision model can't see a chessboard in the call (the frame is open in Preview).",
      "Share the glasses' view (double-tap) and look at the board, then try again.",
    );
  }
  console.log("   ✓ the board is in view (the frame is open in Preview)");

  await ask("\n3. Press Enter, then listen in the glasses.");
  let played = true;
  const speaker = new Speaker("call", { onFailed: () => (played = false) });
  speaker.say("chesshacker test. Knight to f3.");
  await speaker.wait();
  if (!played) {
    return failed(
      `macOS couldn't play speech on ${BLACKHOLE}.`,
      `Check that ${BLACKHOLE} is listed in System Settings → Sound → Output (reinstall it if not), then run test-call again.`,
    );
  }
  if ((await ask('   Did you hear "chesshacker test, knight to f3"? [y/n] ')).trim().toLowerCase() !== "y") {
    return failed(
      "The glasses didn't get the speech.",
      "In the call window choose ⋯ → Microphone → BlackHole 2ch (or set System Settings → Sound → Input to BlackHole 2ch), then run test-call again.",
    );
  }

  const app = await macos.whatsapp();
  if (app) config.saveTested({ whatsapp: app.version });
  console.log(`\nAll good: WhatsApp ${app?.version ?? ""} works with chesshacker. Start a game with \`npx chesshacker run --color white\` (or black).`);
  return 0;
}

function failed(problem: string, fix: string): number {
  console.log(`\n✗ ${problem}\n  → ${fix}`);
  return 1;
}

/** List WhatsApp's windows (or every app's), to pick the call window by hand if needed. */
async function listWindows(options: { all?: boolean }): Promise<number> {
  if (process.platform !== "darwin") return failed("Window capture needs macOS.", "Run this command in Terminal on your Mac.");
  const found = await macos.windows(options.all ? undefined : "WhatsApp");
  const picked = await macos.callWindow();
  if (!found.length) console.log(options.all ? "No visible windows." : "No visible WhatsApp windows. Is a call open?");
  for (const w of found) {
    const mark = picked && w.id === picked.id ? "→" : " ";
    console.log(`${mark} ${String(w.id).padStart(7)}  ${w.owner.padEnd(20)} ${w.width}×${w.height}  ${w.title || "(no title)"}`);
  }
  if (found.length && !(await macos.screenRecordingAllowed())) {
    console.log(`\nTitles are hidden until ${macos.terminalApp()} has Screen Recording permission.`);
  }
  if (picked) console.log("\n→ is the window `run` would watch. Use --window ID to pick another.");
  return 0;
}

function timestamp(): string {
  const d = new Date();
  const two = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}-${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}-${process.pid}`;
}

function number(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new InvalidArgumentError("Not a number.");
  return parsed;
}

function integer(value: string): number {
  const parsed = number(value);
  if (!Number.isInteger(parsed)) throw new InvalidArgumentError("Not a whole number.");
  return parsed;
}

function positive(value: string): number {
  const parsed = number(value);
  if (parsed <= 0) throw new InvalidArgumentError("Must be greater than zero.");
  return parsed;
}

function nonnegative(value: string): number {
  const parsed = number(value);
  if (parsed < 0) throw new InvalidArgumentError("Must be zero or greater.");
  return parsed;
}

export function program(): Command {
  const cli = new Command("chesshacker").description("Hear the best chess move through your Meta glasses.");
  const exit = (code: number) => {
    process.exitCode = code;
  };
  cli.command("setup").description("install what's missing, then check everything")
    .option("--engine-only", "install/check Stockfish without glasses, keys or macOS setup")
    .action(async (options: { engineOnly?: boolean }) => exit(await setup(options)));
  cli.command("demo").description("offline scripted observations with real Stockfish; no vision API")
    .option("--no-browser", "don't open the command center")
    .option("--exit-at-end", "quit when the scripted game ends")
    .option("--every <seconds>", "pace of synthetic frames", positive, 0.5)
    .action(async (options: { browser: boolean; exitAtEnd?: boolean; every: number }) => exit(await demo(options)));
  cli.command("doctor").description("check this Mac is ready, with exact fixes").action(async () => exit(await doctor.run()));
  cli
    .command("run")
    .description("play: watch the call and speak the best moves")
    .addOption(new Option("--color <color>", "your color").choices(["white", "black"]).makeOptionMandatory())
    .option("--fen <fen>", "starting position, when joining a game already in progress")
    .option("--model <model>", "the vision model", config.visionModel())
    .addOption(new Option("--strategy <strategy>", "how to ask the model").choices(STRATEGIES).default(config.DEFAULT_STRATEGY))
    .option("--no-gate", "send every frame to the vision model")
    .addOption(
      new Option("--speak <where>", "into the call (BlackHole), out of this Mac's speakers, or not at all")
        .choices(["call", "speakers", "none"])
        .default("call"),
    )
    .option("--video <file>", "play back a recording instead of watching the call")
    .option("--speed <times>", "playback speed for --video", positive, 1.0)
    .option("--exit-at-end", "with --video, quit when it ends")
    .option("--window <id>", "the call window's ID (see `chesshacker windows`)", integer)
    .option("--every <seconds>", "seconds between frames", positive, 1.0)
    .option("--max-cost <dollars>", "pause when estimated spending passes this ($)", positive, 10.0)
    .option("--max-advice-age <seconds>", "suppress speech for captures older than this; 0 disables", nonnegative, 30)
    .option("--no-browser", "don't open the command center")
    .option("--overlay-out <file-or-url>", "also record or stream the overlay video: overlay.mp4, rtmp://…, udp://127.0.0.1:1234")
    .option("--overlay-fps <fps>", "frames per second of the overlay video", positive, 10)
    .option("--locate-every <seconds>", "seconds between finding the board for the overlay", positive, 5)
    .option("--locate-model <model>", "the model that finds the board for the overlay (default: --model)")
    .action(async (options: RunOptions) => exit(await play(options)));
  cli
    .command("test-call")
    .description("check a real call: video in, speech out")
    .option("--window <id>", "the call window's ID (see `chesshacker windows`)", integer)
    .action(async (options: { window?: number }) => exit(await testCall(options)));
  cli
    .command("windows")
    .description("list WhatsApp's windows")
    .option("--all", "every app's windows")
    .action(async (options: { all?: boolean }) => exit(await listWindows(options)));
  return cli;
}

await program().parseAsync().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
