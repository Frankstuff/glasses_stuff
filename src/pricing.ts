/** What model calls cost. */

// USD per million input / output tokens, checked 2026-10-28. Standard, uncached,
// short-context estimates (not a billing ledger). Sources:
// https://developers.openai.com/api/docs/pricing
// https://docs.claude.com/en/docs/about-claude/pricing
// https://docs.typesafe.ai/models
export const PRICES: Record<string, [number, number]> = {
  "claude-opus-5-5": [4.0, 20.0],
  "claude-sonnet-5-5": [2.0, 10.0],
  "claude-haiku-5-5": [0.1, 0.5],
  "gpt-6-astra": [10.0, 50.0],
  "gpt-6.1-sol": [2.0, 10.0],
  "gpt-6-luna": [0.1, 0.5],
  "jev-1.14.0": [0.042, 0.0],
  "jev-latest": [0.042, 0.0], // currently resolves to jev-1.14.0; versioned IDs are preferred
};

export function price(model: string): [number, number] | null {
  const names = Object.keys(PRICES).sort((a, b) => b.length - a.length);
  const name = names.find((n) => model === n || (model.startsWith(`${n}-`) && /^\d{4}-\d{2}-\d{2}$|^\d{8}$/.test(model.slice(n.length + 1))));
  return name ? PRICES[name] : null;
}

/**
 * Estimated dollars for one call. Unknown returned models must use the explicitly supplied
 * requested model's rate or fail visibly, even when usage is zero.
 */
export function cost(model: string, inputTokens: number, outputTokens = 0, requestedModel?: string): number {
  const rate = price(model) ?? (requestedModel ? price(requestedModel) : null);
  if (!rate) throw new Error(`Unknown token price for ${model}; configure a documented model rate before using it.`);
  if (![inputTokens, outputTokens].every((n) => Number.isFinite(n) && n >= 0)) {
    throw new Error("Token counts must be finite, nonnegative numbers.");
  }
  const [inputPrice, outputPrice] = rate;
  return (inputTokens * inputPrice + outputTokens * outputPrice) / 1_000_000;
}
