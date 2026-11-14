// Model prices in USD per million tokens (Anthropic first-party, checked Oct 2026).
// Cache writes cost 1.25× input (5-minute TTL), cache reads 0.1×.
export const MODEL_PRICES: Record<string, { input: number; output: number; cacheRead: number }> = {
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2 },
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2 },
};

export type Usage = {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
};

export function modelCost(model: string, u: Usage): number {
  const p = MODEL_PRICES[model];
  if (!p) throw new Error(`No price for model ${model}; add it to core/prices.ts`);
  return (
    ((u.input_tokens ?? 0) * p.input +
      (u.output_tokens ?? 0) * p.output +
      (u.cache_read_input_tokens ?? 0) * p.cacheRead +
      (u.cache_creation_input_tokens ?? 0) * p.input * 1.25) /
    1e6
  );
}
