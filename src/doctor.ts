/**
 * `chesshacker doctor`: check this Mac is ready, and say exactly how to fix what isn't.
 *
 * Every dependency gets a check here the day it's added.
 */

import { execFileSync } from "node:child_process";
import { arch, homedir, platform } from "node:os";

import Anthropic from "@anthropic-ai/sdk";
import { AuthenticationError as TypeSafeAuthenticationError, TypeSafeError } from "@typesafe-ai/sdk";
import OpenAI from "openai";

import * as config from "./config.js";
import { Engine, findStockfish, installedPath } from "./engine.js";
import { KeychainError } from "./keychain.js";
import * as macos from "./macos.js";
import { BLACKHOLE } from "./speak.js";

export const SETUP = "npx chesshacker setup";

export interface Check {
  ok: boolean;
  name: string;
  detail: string;
  fix?: string;
  optional?: boolean; // a failed optional check is reported but doesn't block anything
}

export type CheckFn = () => Promise<Check>;

export async function checkMacos(): Promise<Check> {
  if (platform() !== "darwin") return { ok: false, name: "macOS live hardware", detail: `this is ${platform()}; WhatsApp capture, Screen Recording, Keychain storage, and call audio require macOS`, fix: "Use demo, image, or video input here; run live glasses capture and call audio on a Mac." };
  const version = execFileSync("sw_vers", ["-productVersion"], { encoding: "utf8" }).trim();
  const chip = arch() === "arm64" ? "Apple silicon" : "Intel";
  return { ok: true, name: "macOS", detail: `${version} (${chip})` };
}

export async function checkStockfish(): Promise<Check> {
  const path = findStockfish();
  if (path === null) return { ok: false, name: "Stockfish", detail: "not installed", fix: `Run \`${SETUP}\` to download it.` };
  try {
    const engine = await Engine.start(path);
    engine.close();
    return { ok: true, name: "Stockfish", detail: `${engine.name} at ${short(path)}` };
  } catch (error) {
    const fix = path === installedPath() ? `Run \`${SETUP}\` to download a fresh copy.` : `Fix or remove ${path}, then run \`${SETUP}\`.`;
    return { ok: false, name: "Stockfish", detail: `${short(path)} didn't start (${(error as Error).message})`, fix };
  }
}

/** The OpenAI key, checked with a free API call. Required when `model` (the vision model) is GPT. */
export async function checkOpenai(key?: string, model = config.visionModel()): Promise<Check> {
  const optional = config.provider(model) !== "openai";
  const name = `OpenAI API key${optional ? " (only needed for GPT models)" : ` (for ${model})`}`;
  let apiKey: string | null;
  try {
    apiKey = key ?? config.openaiKey();
  } catch (error) {
    if (!(error instanceof KeychainError)) throw error;
    return { ok: false, name, detail: `couldn't read the Keychain (${error.message})`, fix: unlock("OPENAI_API_KEY"), optional };
  }
  const fromEnv = apiKey !== null && apiKey === process.env.OPENAI_API_KEY;
  const enterKey = fromEnv ? "Fix or unset OPENAI_API_KEY." : credentialFix("OPENAI_API_KEY", "platform.openai.com");
  if (!apiKey) return { ok: false, name, detail: "none found", fix: enterKey, optional };
  try {
    const client = config.openaiClient(apiKey);
    if (optional) await client.models.list();
    else await client.models.retrieve(model);
  } catch (error) {
    if (error instanceof OpenAI.AuthenticationError) return { ok: false, name, detail: "the key was rejected", fix: enterKey, optional };
    if (error instanceof OpenAI.NotFoundError) {
      return { ok: false, name, detail: `this key can't use ${model}`, fix: "Use a key with access to it.", optional };
    }
    if (error instanceof OpenAI.APIConnectionError) {
      return { ok: false, name, detail: "couldn't reach the OpenAI API", fix: "Check your internet connection.", optional };
    }
    throw error;
  }
  return { ok: true, name, detail: `works (${fromEnv ? "OPENAI_API_KEY" : "Keychain"})` };
}

/** The Anthropic key, checked with a free API call. Required when `model` (the vision model) is Claude. */
export async function checkAnthropic(key?: string, model = config.visionModel()): Promise<Check> {
  const optional = config.provider(model) !== "anthropic";
  const name = `Anthropic API key${optional ? " (only needed for Claude models)" : ` (for ${model})`}`;
  let apiKey: string | null;
  try {
    apiKey = key ?? config.anthropicKey();
  } catch (error) {
    if (!(error instanceof KeychainError)) throw error;
    return { ok: false, name, detail: `couldn't read the Keychain (${error.message})`, fix: unlock("ANTHROPIC_API_KEY"), optional };
  }
  const fromEnv = apiKey !== null && apiKey === process.env.ANTHROPIC_API_KEY;
  const enterKey = fromEnv
    ? "Fix or unset ANTHROPIC_API_KEY."
    : credentialFix("ANTHROPIC_API_KEY", "console.anthropic.com");
  if (!apiKey) return { ok: false, name, detail: "none found", fix: enterKey, optional };
  try {
    const client = config.anthropicClient(apiKey);
    if (optional) await client.models.list({ limit: 1 });
    else await client.models.retrieve(model);
  } catch (error) {
    if (error instanceof Anthropic.AuthenticationError) return { ok: false, name, detail: "the key was rejected", fix: enterKey, optional };
    if (error instanceof Anthropic.NotFoundError) {
      return { ok: false, name, detail: `this key can't use ${model}`, fix: "Use a key with access to it.", optional };
    }
    if (error instanceof Anthropic.APIConnectionError) {
      return { ok: false, name, detail: "couldn't reach the Anthropic API", fix: "Check your internet connection.", optional };
    }
    if (error instanceof Anthropic.AnthropicError) {
      return { ok: false, name, detail: apiKey ? error.message : "none found", fix: enterKey, optional };
    }
    // With no credentials anywhere the SDK throws a plain Error, not one of its own.
    if (error instanceof Error && error.message.includes("authentication method")) {
      return { ok: false, name, detail: "none found", fix: enterKey, optional };
    }
    throw error;
  }
  const source = fromEnv ? "ANTHROPIC_API_KEY" : apiKey ? "Keychain" : "Anthropic SDK credentials";
  return { ok: true, name, detail: `works (${source})` };
}

/** The key for whichever provider `model` comes from (the configured vision model by default). */
export function checkVisionKey(model = config.visionModel()): Promise<Check> {
  return config.provider(model) === "openai" ? checkOpenai(undefined, model) : checkAnthropic(undefined, model);
}

/** Check `key`, or the saved Jev key, with a free API call. Jev is optional. */
export async function checkJev(key?: string): Promise<Check> {
  const name = "Jev key (frame pre-check, optional)";
  const fix = credentialFix("TYPESAFE_API_KEY", "console.typesafe.ai");
  let apiKey: string | null;
  try {
    apiKey = key ?? config.typesafeKey();
  } catch (error) {
    if (!(error instanceof KeychainError)) throw error;
    return { ok: false, name, detail: `couldn't read the Keychain (${error.message})`, fix, optional: true };
  }
  if (!apiKey) return { ok: false, name, detail: "not set, so every frame goes to the vision model (costs more)", fix, optional: true };
  try {
    await config.typesafeClient(apiKey).models.list();
  } catch (error) {
    if (error instanceof TypeSafeAuthenticationError) return { ok: false, name, detail: "the key was rejected", fix, optional: true };
    if (error instanceof TypeSafeError) {
      return { ok: false, name, detail: `couldn't reach TypeSafe (${error.message})`, fix: "Check your internet connection.", optional: true };
    }
    throw error;
  }
  return { ok: true, name, detail: "works" };
}

export async function checkWhatsapp(): Promise<Check> {
  if (platform() !== "darwin") return macOnly("WhatsApp call capture");
  const app = await macos.whatsapp();
  const install = "Install WhatsApp from the Mac App Store or whatsapp.com/download, then log in.";
  if (app === null) return { ok: false, name: "WhatsApp", detail: "not installed", fix: install };
  if (app.electron) {
    const detail = `found the old WhatsApp Desktop ${app.version}, which WhatsApp has discontinued`;
    return { ok: false, name: "WhatsApp", detail, fix: `Delete it, then: ${install}` };
  }
  if (app.version !== config.tested().whatsapp) {
    // WhatsApp updates often: a version no call has been tested with may still work fine.
    return { ok: true, name: "WhatsApp", detail: `${app.version}, not tested with chesshacker yet: run \`npx chesshacker test-call\`` };
  }
  return { ok: true, name: "WhatsApp", detail: `${app.version}, passed test-call` };
}

export async function checkBlackhole(): Promise<Check> {
  const name = "BlackHole (speaks into the call)";
  if (platform() !== "darwin") return macOnly(name);
  if ((await macos.audioOutputs()).some((device) => device.startsWith(BLACKHOLE))) {
    return { ok: true, name, detail: `${BLACKHOLE} installed` };
  }
  const fix = "brew install blackhole-2ch   (or the installer from existential.audio/blackhole)";
  return { ok: false, name, detail: `${BLACKHOLE} isn't installed`, fix };
}

export async function checkScreenRecording(): Promise<Check> {
  if (platform() !== "darwin") return macOnly("Screen Recording for live capture");
  const app = macos.terminalApp();
  const name = `Screen Recording for ${app} (sees the call)`;
  if (await macos.screenRecordingAllowed()) return { ok: true, name, detail: "allowed" };
  const fix = `Run \`${SETUP}\` to open the setting, turn on ${app}, then quit and reopen it.`;
  return { ok: false, name, detail: "not allowed", fix };
}

export const BASICS: CheckFn[] = [checkMacos, checkStockfish, () => checkVisionKey(), checkJev];
export const CALL: CheckFn[] = [checkWhatsapp, checkBlackhole, checkScreenRecording]; // only for a live call

/** Run `checks` and print the results. Returns 1 if a required one failed, else 0. */
export async function run(checks: CheckFn[] = [...BASICS, ...CALL], print = console.log): Promise<number> {
  print("chesshacker doctor\n");
  let failed = 0;
  for (const check of checks) {
    let result: Check;
    try {
      result = await check();
    } catch (error) {
      // a broken check shouldn't hide the others
      result = { ok: false, name: check.name.replace(/^check/, "") || "check", detail: `check crashed: ${String(error)}` };
    }
    if (!result.ok && !result.optional) failed++;
    const mark = result.ok ? "✓" : result.optional ? "–" : "✗";
    print(`  ${mark} ${result.name}: ${result.detail}`);
    if (result.fix && !result.ok) print(`      → ${result.fix}`);
  }
  print(failed ? `\n${failed} to fix.` : "\nAll set.");
  return failed ? 1 : 0;
}

const unlock = (env: string) => `Unlock your login keychain, or set ${env}.`;
const short = (path: string) => path.replace(homedir(), "~");
const credentialFix = (env: string, consoleUrl: string) => platform() === "darwin"
  ? `Set ${env}, or run \`${SETUP}\` and paste a key from ${consoleUrl}.`
  : `Set ${env} from ${consoleUrl}; macOS Keychain storage is unavailable on ${platform()}.`;
const macOnly = (name: string): Check => ({ ok: false, name, detail: `macOS only; unavailable on ${platform()}`, fix: "Use demo, image, or video input here; use a Mac for the live call." });
