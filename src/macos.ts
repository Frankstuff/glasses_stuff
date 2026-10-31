/** The macOS parts: WhatsApp's call window, screen capture, audio devices, staying awake. */

import { type ChildProcess, execFile, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export const WHATSAPP_PATHS = ["/Applications/WhatsApp.app", join(homedir(), "Applications", "WhatsApp.app")];
export const SCREEN_RECORDING_SETTINGS =
  "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture";
const TERMINALS: Record<string, string> = {
  Apple_Terminal: "Terminal",
  "iTerm.app": "iTerm",
  WarpTerminal: "Warp",
  vscode: "Visual Studio Code",
  ghostty: "Ghostty",
};

export interface App {
  path: string;
  bundleId: string;
  version: string;
  electron: boolean; // the old WhatsApp Desktop, which WhatsApp has discontinued
}

export async function whatsapp(paths: string[] = WHATSAPP_PATHS): Promise<App | null> {
  for (const path of paths) {
    const info = join(path, "Contents", "Info.plist");
    if (!existsSync(info)) continue;
    const { stdout } = await run("plutil", ["-convert", "json", "-o", "-", info]);
    const plist = JSON.parse(stdout) as Record<string, unknown>;
    return {
      path,
      bundleId: String(plist.CFBundleIdentifier ?? "?"),
      version: String(plist.CFBundleShortVersionString ?? "?"),
      electron: existsSync(join(path, "Contents", "Frameworks", "Electron Framework.framework")),
    };
  }
  return null;
}

export interface Window {
  id: number;
  owner: string;
  title: string; // blank without Screen Recording permission
  width: number;
  height: number;
}

/** Runs JavaScript for Automation, which can call CoreGraphics without a native add-on. */
async function jxa(script: string): Promise<string> {
  const { stdout } = await run("osascript", ["-l", "JavaScript", "-e", script]);
  return stdout.trim();
}

const LIST_WINDOWS = `
ObjC.import("CoreGraphics");
const options = $.kCGWindowListOptionOnScreenOnly | $.kCGWindowListExcludeDesktopElements;
const windows = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo(options, $.kCGNullWindowID))) || [];
JSON.stringify(windows.map(w => ({
  id: w.kCGWindowNumber, owner: w.kCGWindowOwnerName || "", title: w.kCGWindowName || "", layer: w.kCGWindowLayer || 0,
  width: (w.kCGWindowBounds || {}).Width || 0, height: (w.kCGWindowBounds || {}).Height || 0,
})));`;

/** Visible app windows, front to back. Minimized windows aren't included. */
export async function windows(owner?: string): Promise<Window[]> {
  const listed = JSON.parse(await jxa(LIST_WINDOWS)) as (Window & { layer: number })[];
  return listed
    .filter((w) => w.layer === 0) // not menus, the Dock, or overlays
    .filter((w) => !owner || w.owner === owner)
    .map(({ id, owner, title, width, height }) => ({ id, owner, title, width: Math.round(width), height: Math.round(height) }));
}

/**
 * The WhatsApp call window: `windowId` if given, otherwise the one pickCallWindow() chooses.
 * Null while there's no call, so nothing is captured or sent to the models.
 */
export async function callWindow(windowId?: number): Promise<Window | null> {
  if (windowId !== undefined) return (await windows()).find((w) => w.id === windowId) ?? null;
  return pickCallWindow(await windows("WhatsApp"));
}

/**
 * The call among WhatsApp's visible windows: the largest one that isn't the main window (titled
 * "WhatsApp"). Never the main window itself, which would mean screenshots of the chat list. If a
 * call ever shows inside the main window, `--window` picks it (`chesshacker windows` lists IDs).
 */
export function pickCallWindow(found: readonly Window[]): Window | null {
  return found
    .filter((w) => w.title !== "WhatsApp")
    .reduce<Window | null>((best, w) => (!best || w.width * w.height > best.width * best.height ? w : best), null);
}

/** A JPEG of the window, even when other windows cover it. Null if it can't be captured. */
export async function capture(windowId: number): Promise<Buffer | null> {
  const dir = mkdtempSync(join(tmpdir(), "chesshacker-"));
  const path = join(dir, "frame.jpg");
  try {
    await run("screencapture", ["-x", "-o", "-l", String(windowId), "-t", "jpg", path]);
    return existsSync(path) ? readFileSync(path) : null;
  } catch {
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export async function screenRecordingAllowed(): Promise<boolean> {
  const answer = await jxa(`
ObjC.import("CoreGraphics");
ObjC.bindFunction("CGPreflightScreenCaptureAccess", ["bool", []]);
String($.CGPreflightScreenCaptureAccess());`);
  return answer === "true";
}

/** Show macOS's permission prompt, then open the Screen Recording settings page. */
export async function askForScreenRecording(): Promise<void> {
  await jxa(`
ObjC.import("CoreGraphics");
ObjC.bindFunction("CGRequestScreenCaptureAccess", ["bool", []]);
String($.CGRequestScreenCaptureAccess());`);
  await run("open", [SCREEN_RECORDING_SETTINGS]);
}

/** The app chesshacker is running in, which is what needs Screen Recording permission. */
export function terminalApp(): string {
  return TERMINALS[process.env.TERM_PROGRAM ?? ""] ?? "the app you run chesshacker in";
}

/** Names of the audio devices `say` can play to. */
export async function audioOutputs(): Promise<string[]> {
  const { stdout } = await run("say", ["-a", "?"]);
  const devices: string[] = [];
  for (const line of stdout.split("\n")) {
    const found = /^\s*(\d+)\s+(.+?)\s*$/.exec(line);
    if (found) devices.push(found[2]);
  }
  return devices;
}

/** Keep the display and system awake until this process exits. */
export function keepAwake(): ChildProcess {
  const child = spawn("caffeinate", ["-dims", "-w", String(process.pid)], { stdio: "ignore" });
  child.unref();
  return child;
}
