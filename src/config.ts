/** Where chesshacker keeps per-user data, which model it uses, and how it finds API keys. */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import Anthropic from "@anthropic-ai/sdk";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import OpenAI from "openai";

import { readSecret, saveSecret } from "./keychain.js";

export const APP = "chesshacker";

// Documented image-input/structured-output model. CHESSHACKER_MODEL overrides.
export const DEFAULT_MODEL = "gpt-6.1-sol";
export const DEFAULT_STRATEGY = "changes";

export const ANTHROPIC_ACCOUNT = "anthropic-api-key";
export const OPENAI_ACCOUNT = "openai-api-key";
export const TYPESAFE_ACCOUNT = "typesafe-api-key";
export const TYPESAFE_IMAGES_HEADER = { "TypeSafe-Danger-Zone-Images": "true" }; // image input is opt-in

export function dataDir(): string {
  const path = process.env.CHESSHACKER_DATA_DIR || (process.platform === "darwin"
    ? join(homedir(), "Library", "Application Support", APP)
    : join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), APP));
  mkdirSync(path, { recursive: true });
  return path;
}

/** What passed `chesshacker test-call` on this Mac, e.g. {"whatsapp": "26.20.74"}. */
export function tested(): Record<string, string> {
  const path = join(dataDir(), "tested.json");
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
}

export function saveTested(values: Record<string, string>): void {
  writeFileSync(join(dataDir(), "tested.json"), JSON.stringify({ ...tested(), ...values }, null, 2));
}

export function visionModel(): string {
  return process.env.CHESSHACKER_MODEL || DEFAULT_MODEL;
}

export type Provider = "openai" | "anthropic";

export function provider(model: string): Provider {
  if (model.startsWith("gpt-")) return "openai";
  if (model.startsWith("claude-")) return "anthropic";
  throw new Error(`Unknown vision provider for ${model}; use a supported gpt- or claude- model.`);
}

/** The environment variable wins; otherwise the key `chesshacker setup` saved. */
function key(env: string, account: string): string | null {
  return process.env[env] || readSecret(account);
}

export const anthropicKey = () => key("ANTHROPIC_API_KEY", ANTHROPIC_ACCOUNT);
export const openaiKey = () => key("OPENAI_API_KEY", OPENAI_ACCOUNT);
export const typesafeKey = () => key("TYPESAFE_API_KEY", TYPESAFE_ACCOUNT);
export const saveAnthropicKey = (secret: string) => saveSecret(ANTHROPIC_ACCOUNT, secret);
export const saveOpenaiKey = (secret: string) => saveSecret(OPENAI_ACCOUNT, secret);
export const saveTypesafeKey = (secret: string) => saveSecret(TYPESAFE_ACCOUNT, secret);

// A frame read takes 4–18 s and a board locate 10–20 s. The SDKs' default of 10 minutes (cut to
// about 5 by Node's fetch) with 2 retries could freeze the game for a quarter of an hour.
const MODEL_TIMEOUT_MS = 45_000;
const MODEL_RETRIES = 1;
// Jev answers in about a second, and a failed pre-check just sends the frame to the vision model.
const JEV_TIMEOUT_MS = 5_000;

/** A client using `apiKey`, the saved key, or whatever credentials the SDK finds on its own. */
export function anthropicClient(apiKey: string | null = anthropicKey()): Anthropic {
  const limits = { timeout: MODEL_TIMEOUT_MS, maxRetries: MODEL_RETRIES };
  return apiKey ? new Anthropic({ apiKey, ...limits }) : new Anthropic(limits);
}

/** Throws OpenAI's OpenAIError when there's no key anywhere. */
export function openaiClient(apiKey: string | null = openaiKey()): OpenAI {
  const limits = { timeout: MODEL_TIMEOUT_MS, maxRetries: MODEL_RETRIES };
  return apiKey ? new OpenAI({ apiKey, ...limits }) : new OpenAI(limits);
}

/** Throws TypeSafe's TypeSafeError when there's no key anywhere. */
export function typesafeClient(apiKey: string | null = typesafeKey()): TypeSafeClient {
  return new TypeSafeClient({
    ...(apiKey ? { apiKey } : {}),
    defaultHeaders: TYPESAFE_IMAGES_HEADER,
    timeout: JEV_TIMEOUT_MS,
    retry: { maxRetries: 0 },
  });
}
