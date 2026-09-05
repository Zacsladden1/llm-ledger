export type Provider = "openai" | "anthropic" | "openrouter";

export type ParsedUsage = {
  provider: Provider;
  model: string;
  usage_date: string; // YYYY-MM-DD
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cost_usd: number;
  raw_cost_present: boolean;
  project?: string | null;
};
