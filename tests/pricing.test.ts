import { describe, expect, it } from "vitest";

import { cost, price } from "../src/pricing.js";

describe("documented token price estimates", () => {
  it("charges input and output tokens at the configured model's rate", () => {
    expect(price("gpt-6.1-sol")).toEqual([2, 10]);
    expect(cost("gpt-6.1-sol", 1_000_000, 1_000_000)).toBe(12);
    expect(cost("claude-sonnet-5-5", 10_000, 1000)).toBeCloseTo(0.03);
    expect(cost("jev-1.14.0", 1_000_000)).toBe(0.042);
  });

  it("recognizes dated snapshots without matching unrelated variants", () => {
    expect(price("gpt-6.1-sol-2026-10-01")).toEqual([2, 10]);
    expect(price("claude-sonnet-5-5-20261001")).toEqual([2, 10]);
    expect(price("gpt-6.1-sol-pro")).toBeNull();
    expect(price("gpt-6.1-solitude")).toBeNull();
    expect(price("jev-unknown")).toBeNull();
  });

  it("never treats an unknown returned model as free, even with zero usage", () => {
    expect(() => cost("unexpected-model", 0)).toThrow("Unknown token price");
    expect(() => cost("unexpected-model", 1000)).toThrow("unexpected-model");
  });

  it("can explicitly estimate an unknown returned model at the requested model's rate", () => {
    expect(cost("unexpected-snapshot", 1_000_000, 1_000_000, "gpt-6.1-sol")).toBe(12);
    expect(cost("claude-opus-5-5", 1_000_000, 1_000_000, "gpt-6.1-sol")).toBe(24);
    expect(() => cost("unexpected-model", 1000, 0, "also-unknown")).toThrow("Unknown token price");
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])("rejects invalid usage %s", (tokens) => {
    expect(() => cost("gpt-6.1-sol", tokens)).toThrow("Token counts");
    expect(() => cost("gpt-6.1-sol", 1, tokens)).toThrow("Token counts");
  });
});
