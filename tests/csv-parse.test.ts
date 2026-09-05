import { describe, expect, it } from "vitest";
import {
  importProviderCsv,
  mapOpenAI,
  mapAnthropic,
  mapOpenRouter,
  parseCsvText,
} from "../src/importers/parse.js";

describe("parseCsvText", () => {
  it("parses headers and rows with BOM and loose columns", () => {
    const csv =
      "\uFEFFdate,model,prompt_tokens,completion_tokens,cost\n" +
      "2026-03-01,gpt-4o-mini,100,50,0.01\n" +
      "2026-03-02,gpt-4o,200,80,\n";
    const rows = parseCsvText(csv);
    expect(rows).toHaveLength(2);
    expect(rows[0].model).toBe("gpt-4o-mini");
  });
});

describe("openai importer", () => {
  it("maps OpenAI usage export columns and uses CSV cost when present", () => {
    const rows = parseCsvText(
      "date,model,input_tokens,output_tokens,cost_usd,project\n" +
        "2026-04-10,gpt-4o,1000,500,0.05,acme\n"
    );
    const parsed = mapOpenAI(rows);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({
      provider: "openai",
      model: "gpt-4o",
      usage_date: "2026-04-10",
      input_tokens: 1000,
      output_tokens: 500,
      cost_usd: 0.05,
      raw_cost_present: true,
      project: "acme",
    });
  });

  it("falls back to pricing map when cost missing", () => {
    const rows = parseCsvText(
      "date,model,prompt_tokens,completion_tokens\n" +
        "2026-04-11,gpt-4o-mini,1000000,1000000\n"
    );
    const parsed = mapOpenAI(rows);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].raw_cost_present).toBe(false);
    expect(parsed[0].cost_usd).toBeCloseTo(0.75, 5);
  });

  it("skips rows without a parseable date", () => {
    const rows = parseCsvText("model,prompt_tokens\nGPT,10\n");
    expect(mapOpenAI(rows)).toHaveLength(0);
  });
});

describe("anthropic importer", () => {
  it("accepts workspace alias and spend column", () => {
    const rows = parseCsvText(
      "created_at,model,tokens_input,tokens_output,spend,workspace\n" +
        "2026-05-01T12:00:00Z,claude-3-5-haiku,2000,1000,0.02,ops\n"
    );
    const parsed = mapAnthropic(rows);
    expect(parsed[0]).toMatchObject({
      provider: "anthropic",
      usage_date: "2026-05-01",
      cost_usd: 0.02,
      project: "ops",
      raw_cost_present: true,
    });
  });
});

describe("openrouter importer", () => {
  it("maps generation-style columns", () => {
    const rows = parseCsvText(
      "created_at,model,prompt_tokens,completion_tokens,cost\n" +
        "03/15/2026,openai/gpt-4o-mini,100,20,0.001\n"
    );
    const parsed = mapOpenRouter(rows);
    expect(parsed[0].usage_date).toBe("2026-03-15");
    expect(parsed[0].cost_usd).toBeCloseTo(0.001, 6);
  });
});

describe("importProviderCsv", () => {
  it("dispatches by provider", () => {
    const csv =
      "date,model,input_tokens,output_tokens,cost\n2026-01-01,gpt-4o,1,1,0\n";
    expect(importProviderCsv("openai", csv)).toHaveLength(1);
    expect(importProviderCsv("anthropic", csv)).toHaveLength(1);
    expect(importProviderCsv("openrouter", csv)).toHaveLength(1);
  });
});
