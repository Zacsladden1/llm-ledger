/**
 * Fallback USD pricing per 1M tokens when a CSV row has no cost column.
 * Rates are approximate public list prices — override by importing CSVs
 * that already include USD cost.
 */
export type ModelPrice = {
  inputPer1M: number;
  outputPer1M: number;
};

/** provider -> model -> price */
export const PRICING: Record<string, Record<string, ModelPrice>> = {
  openai: {
    "gpt-4o": { inputPer1M: 2.5, outputPer1M: 10 },
    "gpt-4o-mini": { inputPer1M: 0.15, outputPer1M: 0.6 },
    "gpt-4.1": { inputPer1M: 2, outputPer1M: 8 },
    "gpt-4.1-mini": { inputPer1M: 0.4, outputPer1M: 1.6 },
    "gpt-4.1-nano": { inputPer1M: 0.1, outputPer1M: 0.4 },
    "o1": { inputPer1M: 15, outputPer1M: 60 },
    "o1-mini": { inputPer1M: 1.1, outputPer1M: 4.4 },
    "o3-mini": { inputPer1M: 1.1, outputPer1M: 4.4 },
    "gpt-3.5-turbo": { inputPer1M: 0.5, outputPer1M: 1.5 },
  },
  anthropic: {
    "claude-opus-4": { inputPer1M: 15, outputPer1M: 75 },
    "claude-sonnet-4": { inputPer1M: 3, outputPer1M: 15 },
    "claude-3-5-sonnet": { inputPer1M: 3, outputPer1M: 15 },
    "claude-3-5-haiku": { inputPer1M: 0.8, outputPer1M: 4 },
    "claude-3-opus": { inputPer1M: 15, outputPer1M: 75 },
    "claude-3-sonnet": { inputPer1M: 3, outputPer1M: 15 },
    "claude-3-haiku": { inputPer1M: 0.25, outputPer1M: 1.25 },
  },
  openrouter: {
    "openai/gpt-4o": { inputPer1M: 2.5, outputPer1M: 10 },
    "openai/gpt-4o-mini": { inputPer1M: 0.15, outputPer1M: 0.6 },
    "anthropic/claude-3.5-sonnet": { inputPer1M: 3, outputPer1M: 15 },
    "anthropic/claude-3-haiku": { inputPer1M: 0.25, outputPer1M: 1.25 },
    "google/gemini-2.0-flash-001": { inputPer1M: 0.1, outputPer1M: 0.4 },
    "meta-llama/llama-3.3-70b-instruct": { inputPer1M: 0.12, outputPer1M: 0.3 },
  },
};

function normalizeModel(model: string): string {
  return model.trim().toLowerCase();
}

function lookupPrice(provider: string, model: string): ModelPrice | undefined {
  const byProvider = PRICING[provider.toLowerCase()];
  if (!byProvider) return undefined;
  const key = normalizeModel(model);
  if (byProvider[key]) return byProvider[key];
  for (const [k, v] of Object.entries(byProvider)) {
    const nk = normalizeModel(k);
    if (key.includes(nk) || nk.includes(key)) return v;
  }
  return undefined;
}

export function estimateCostUsd(
  provider: string,
  model: string,
  inputTokens: number,
  outputTokens: number
): number | null {
  const price = lookupPrice(provider, model);
  if (!price) return null;
  const cost =
    (inputTokens / 1_000_000) * price.inputPer1M +
    (outputTokens / 1_000_000) * price.outputPer1M;
  return Math.round(cost * 1_000_000) / 1_000_000;
}
