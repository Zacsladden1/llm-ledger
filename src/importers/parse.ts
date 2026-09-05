import { parse } from "csv-parse/sync";
import { estimateCostUsd } from "../pricing.js";
import type { ParsedUsage, Provider } from "./types.js";

export function parseCsvText(text: string): Record<string, string>[] {
  const records = parse(text, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    relax_column_count: true,
    relax_quotes: true,
    bom: true,
  }) as Record<string, string>[];
  return records;
}

/** Case-insensitive column lookup with aliases. */
export function col(
  row: Record<string, string>,
  ...aliases: string[]
): string | undefined {
  const keys = Object.keys(row);
  const lower = new Map(keys.map((k) => [k.toLowerCase().replace(/\s+/g, "_"), k]));
  for (const alias of aliases) {
    const hit = lower.get(alias.toLowerCase().replace(/\s+/g, "_"));
    if (hit !== undefined) {
      const v = row[hit];
      if (v !== undefined && String(v).trim() !== "") return String(v).trim();
    }
  }
  return undefined;
}

export function toNumber(value: string | undefined, fallback = 0): number {
  if (value === undefined || value === "") return fallback;
  const cleaned = value.replace(/[$,]/g, "").replace(/,/g, "");
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : fallback;
}

export function toDate(value: string | undefined): string | null {
  if (!value) return null;
  const s = value.trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const mdy = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (mdy) {
    const mm = mdy[1].padStart(2, "0");
    const dd = mdy[2].padStart(2, "0");
    return `${mdy[3]}-${mm}-${dd}`;
  }
  const d = new Date(s);
  if (!Number.isNaN(d.getTime())) {
    return d.toISOString().slice(0, 10);
  }
  return null;
}

export function finalizeCost(
  provider: Provider,
  model: string,
  inputTokens: number,
  outputTokens: number,
  rawCost: number | null
): { cost_usd: number; raw_cost_present: boolean } {
  if (rawCost !== null && Number.isFinite(rawCost)) {
    return { cost_usd: rawCost, raw_cost_present: true };
  }
  const estimated = estimateCostUsd(provider, model, inputTokens, outputTokens);
  return {
    cost_usd: estimated ?? 0,
    raw_cost_present: false,
  };
}

export function mapOpenAI(rows: Record<string, string>[]): ParsedUsage[] {
  const out: ParsedUsage[] = [];
  for (const row of rows) {
    const model =
      col(row, "model", "model_id", "engine") ?? "unknown";
    const usage_date =
      toDate(col(row, "date", "usage_date", "timestamp", "day", "start_time")) ??
      null;
    if (!usage_date) continue;
    const input_tokens = toNumber(
      col(row, "input_tokens", "prompt_tokens", "n_context_tokens_total", "input")
    );
    const output_tokens = toNumber(
      col(row, "output_tokens", "completion_tokens", "n_generated_tokens_total", "output")
    );
    const total_tokens =
      toNumber(col(row, "total_tokens", "tokens"), 0) ||
      input_tokens + output_tokens;
    const raw =
      col(row, "cost", "cost_usd", "amount", "usd", "total_cost") !== undefined
        ? toNumber(col(row, "cost", "cost_usd", "amount", "usd", "total_cost"))
        : null;
    const { cost_usd, raw_cost_present } = finalizeCost(
      "openai",
      model,
      input_tokens,
      output_tokens,
      raw
    );
    const project = col(row, "project", "project_id", "organization", "org_id");
    out.push({
      provider: "openai",
      model,
      usage_date,
      input_tokens,
      output_tokens,
      total_tokens,
      cost_usd,
      raw_cost_present,
      project: project ?? null,
    });
  }
  return out;
}

export function mapAnthropic(rows: Record<string, string>[]): ParsedUsage[] {
  const out: ParsedUsage[] = [];
  for (const row of rows) {
    const model =
      col(row, "model", "model_id", "claude_model") ?? "unknown";
    const usage_date =
      toDate(
        col(row, "date", "usage_date", "timestamp", "day", "created_at", "start_date")
      ) ?? null;
    if (!usage_date) continue;
    const input_tokens = toNumber(
      col(row, "input_tokens", "prompt_tokens", "tokens_input", "input")
    );
    const output_tokens = toNumber(
      col(row, "output_tokens", "completion_tokens", "tokens_output", "output")
    );
    const total_tokens =
      toNumber(col(row, "total_tokens", "tokens"), 0) ||
      input_tokens + output_tokens;
    const raw =
      col(row, "cost", "cost_usd", "amount", "usd", "total_cost", "spend") !==
      undefined
        ? toNumber(
            col(row, "cost", "cost_usd", "amount", "usd", "total_cost", "spend")
          )
        : null;
    const { cost_usd, raw_cost_present } = finalizeCost(
      "anthropic",
      model,
      input_tokens,
      output_tokens,
      raw
    );
    const project = col(row, "project", "workspace", "workspace_id", "organization");
    out.push({
      provider: "anthropic",
      model,
      usage_date,
      input_tokens,
      output_tokens,
      total_tokens,
      cost_usd,
      raw_cost_present,
      project: project ?? null,
    });
  }
  return out;
}

export function mapOpenRouter(rows: Record<string, string>[]): ParsedUsage[] {
  const out: ParsedUsage[] = [];
  for (const row of rows) {
    const model =
      col(row, "model", "model_id", "model_name") ?? "unknown";
    const usage_date =
      toDate(
        col(row, "date", "usage_date", "timestamp", "day", "created_at", "generation_time")
      ) ?? null;
    if (!usage_date) continue;
    const input_tokens = toNumber(
      col(row, "prompt_tokens", "input_tokens", "tokens_prompt", "native_tokens_prompt")
    );
    const output_tokens = toNumber(
      col(
        row,
        "completion_tokens",
        "output_tokens",
        "tokens_completion",
        "native_tokens_completion"
      )
    );
    const total_tokens =
      toNumber(col(row, "total_tokens", "tokens", "native_tokens_total"), 0) ||
      input_tokens + output_tokens;
    const raw =
      col(row, "cost", "cost_usd", "total_cost", "amount", "usd") !== undefined
        ? toNumber(col(row, "cost", "cost_usd", "total_cost", "amount", "usd"))
        : null;
    const { cost_usd, raw_cost_present } = finalizeCost(
      "openrouter",
      model,
      input_tokens,
      output_tokens,
      raw
    );
    const project = col(row, "project", "app", "title", "generation_id");
    out.push({
      provider: "openrouter",
      model,
      usage_date,
      input_tokens,
      output_tokens,
      total_tokens,
      cost_usd,
      raw_cost_present,
      project: project ?? null,
    });
  }
  return out;
}

export function importProviderCsv(
  provider: Provider,
  csvText: string
): ParsedUsage[] {
  const rows = parseCsvText(csvText);
  switch (provider) {
    case "openai":
      return mapOpenAI(rows);
    case "anthropic":
      return mapAnthropic(rows);
    case "openrouter":
      return mapOpenRouter(rows);
    default: {
      const _exhaustive: never = provider;
      throw new Error(`Unsupported provider: ${_exhaustive}`);
    }
  }
}

export const EXPECTED_COLUMNS: Record<Provider, string> = {
  openai:
    "Expected columns (flexible aliases): date|usage_date|timestamp, model, input_tokens|prompt_tokens, output_tokens|completion_tokens, optional cost|cost_usd, optional project.",
  anthropic:
    "Expected columns (flexible aliases): date|created_at|usage_date, model, input_tokens|tokens_input, output_tokens|tokens_output, optional cost|spend, optional project|workspace.",
  openrouter:
    "Expected columns (flexible aliases): date|created_at|generation_time, model, prompt_tokens|input_tokens, completion_tokens|output_tokens, optional cost, optional project|app.",
};
