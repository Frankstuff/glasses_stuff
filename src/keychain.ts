/**
 * API keys in the macOS login Keychain, through the built-in `security` tool.
 *
 * Items are generic passwords with service "chesshacker", the same ones the Python version saved
 * through `keyring`. Keys go to `security` on stdin, never on the command line.
 */

import { spawnSync } from "node:child_process";

export const SERVICE = "chesshacker";
const NOT_FOUND = 44; // what `security` exits with when there's no such item

export class KeychainError extends Error {}

export function readSecret(account: string, service = SERVICE): string | null {
  // Environment credentials work on every platform; only macOS has the login Keychain.
  if (process.platform !== "darwin") return null;
  const result = spawnSync("security", ["find-generic-password", "-s", service, "-a", account, "-w"], {
    encoding: "utf8",
  });
  if (result.status === 0) return result.stdout.replace(/\n$/, "");
  if (result.status === NOT_FOUND) return null;
  throw new KeychainError(result.stderr.trim() || `security exited with ${result.status}`);
}

/**
 * Save `secret`, then read it back to make sure the Keychain kept all of it.
 *
 * The command goes to `security -i` on stdin, so the key never shows on a command line, with the
 * key in hex (`-X`). Not `-w`: `security` reads that password with getpass(), which takes it from
 * the terminal rather than stdin whenever there is one, and keeps only its first 128 characters.
 */
export function saveSecret(account: string, secret: string, service = SERVICE): void {
  if (process.platform !== "darwin") {
    throw new KeychainError("Saving keys requires the macOS login Keychain; set OPENAI_API_KEY, ANTHROPIC_API_KEY, or TYPESAFE_API_KEY in the environment instead.");
  }
  const hex = Buffer.from(secret, "utf8").toString("hex");
  const result = spawnSync("security", ["-i"], {
    input: `add-generic-password -U -s ${service} -a ${account} -X ${hex}\n`,
    encoding: "utf8",
  });
  const problem = result.stderr.trim();
  if (result.status !== 0) throw new KeychainError(problem || `security exited with ${result.status}`);
  if (readSecret(account, service) !== secret) throw new KeychainError(problem || "the Keychain didn't keep the key");
}
