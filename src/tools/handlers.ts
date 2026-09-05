import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import {
  insertImport,
  insertUsageBatch,
  listImports,
  setBudget,
  getBudget,
  spendInRange,
  spendByProject,
  invoiceSummary,
} from "../db.js";
import {
  EXPECTED_COLUMNS,
  importProviderCsv,
} from "../importers/parse.js";
import type { Provider } from "../importers/types.js";
import { monthBounds, parseYearMonth } from "../dates.js";

const PROVIDERS: Provider[] = ["openai", "anthropic", "openrouter"];

function assertProvider(p: string): Provider {
  if (!PROVIDERS.includes(p as Provider)) {
    throw new Error(
      `Unsupported provider "${p}". Use one of: ${PROVIDERS.join(", ")}`
    );
  }
  return p as Provider;
}

export function handleImportCsv(
  db: Database.Database,
  args: {
    provider: string;
    file_path: string;
    project?: string;
    csv_text?: string;
  }
): object {
  const provider = assertProvider(args.provider);
  let text: string;
  let filename: string;
  if (args.csv_text && args.csv_text.length > 0) {
    text = args.csv_text;
    filename = args.file_path || "inline.csv";
  } else {
    const resolved = path.resolve(args.file_path);
    if (!fs.existsSync(resolved)) {
      throw new Error(`File not found: ${resolved}`);
    }
    text = fs.readFileSync(resolved, "utf8");
    filename = path.basename(resolved);
  }

  const parsed = importProviderCsv(provider, text);
  if (parsed.length === 0) {
    return {
      ok: false,
      provider,
      filename,
      imported: 0,
      message: `No usable rows parsed. ${EXPECTED_COLUMNS[provider]}`,
    };
  }

  const projectOverride = args.project?.trim() || null;
  const importId = insertImport(
    db,
    provider,
    filename,
    projectOverride,
    parsed.length
  );

  insertUsageBatch(
    db,
    parsed.map((r) => ({
      provider: r.provider,
      model: r.model,
      project: projectOverride ?? r.project ?? null,
      usage_date: r.usage_date,
      input_tokens: r.input_tokens,
      output_tokens: r.output_tokens,
      total_tokens: r.total_tokens,
      cost_usd: r.cost_usd,
      raw_cost_present: r.raw_cost_present ? 1 : 0,
      import_id: importId,
    }))
  );

  const totalCost = parsed.reduce((s, r) => s + r.cost_usd, 0);
  const pricedFromCsv = parsed.filter((r) => r.raw_cost_present).length;
  const pricedFromFallback = parsed.length - pricedFromCsv;

  return {
    ok: true,
    import_id: importId,
    provider,
    filename,
    imported: parsed.length,
    total_cost_usd: roundMoney(totalCost),
    priced_from_csv: pricedFromCsv,
    priced_from_fallback: pricedFromFallback,
    expected_columns: EXPECTED_COLUMNS[provider],
  };
}

export function handleSpendThisMonth(
  db: Database.Database,
  args: { project?: string; month?: string }
): object {
  const { start, end } = args.month
    ? parseYearMonth(args.month)
    : monthBounds();
  const summary = spendInRange(db, start, end, args.project ?? null);
  return {
    period_start: start,
    period_end_exclusive: end,
    project: args.project ?? null,
    cost_usd: roundMoney(summary.cost_usd),
    rows: summary.rows,
    input_tokens: summary.input_tokens,
    output_tokens: summary.output_tokens,
  };
}

export function handleSpendByProject(
  db: Database.Database,
  args: { month?: string }
): object {
  const { start, end } = args.month
    ? parseYearMonth(args.month)
    : monthBounds();
  const rows = spendByProject(db, start, end).map((r) => ({
    ...r,
    cost_usd: roundMoney(r.cost_usd),
  }));
  const total = rows.reduce((s, r) => s + r.cost_usd, 0);
  return {
    period_start: start,
    period_end_exclusive: end,
    total_cost_usd: roundMoney(total),
    projects: rows,
  };
}

export function handleInvoiceSummary(
  db: Database.Database,
  args: { month?: string; project?: string }
): object {
  const { start, end } = args.month
    ? parseYearMonth(args.month)
    : monthBounds();
  const lines = invoiceSummary(db, start, end, args.project ?? null).map(
    (r) => ({
      ...r,
      cost_usd: roundMoney(r.cost_usd),
    })
  );
  const total = lines.reduce((s, r) => s + r.cost_usd, 0);
  return {
    period_start: start,
    period_end_exclusive: end,
    project: args.project ?? null,
    total_cost_usd: roundMoney(total),
    lines,
  };
}

export function handleSetBudget(
  db: Database.Database,
  args: { project: string; monthly_limit_usd: number }
): object {
  if (!args.project?.trim()) throw new Error("project is required");
  if (
    typeof args.monthly_limit_usd !== "number" ||
    !Number.isFinite(args.monthly_limit_usd) ||
    args.monthly_limit_usd < 0
  ) {
    throw new Error("monthly_limit_usd must be a non-negative number");
  }
  setBudget(db, args.project.trim(), args.monthly_limit_usd);
  return {
    ok: true,
    project: args.project.trim(),
    monthly_limit_usd: args.monthly_limit_usd,
  };
}

export function handleCheckBudget(
  db: Database.Database,
  args: { project: string; month?: string }
): object {
  if (!args.project?.trim()) throw new Error("project is required");
  const project = args.project.trim();
  const budget = getBudget(db, project);
  const { start, end } = args.month
    ? parseYearMonth(args.month)
    : monthBounds();
  const spent = spendInRange(db, start, end, project);
  const limit = budget?.monthly_limit_usd ?? null;
  const remaining =
    limit === null ? null : roundMoney(limit - spent.cost_usd);
  const over =
    limit === null ? false : spent.cost_usd > limit;
  return {
    project,
    period_start: start,
    period_end_exclusive: end,
    monthly_limit_usd: limit,
    spent_usd: roundMoney(spent.cost_usd),
    remaining_usd: remaining,
    over_budget: over,
    budget_set: Boolean(budget),
  };
}

export function handleListImports(db: Database.Database): object {
  return { imports: listImports(db) };
}

function roundMoney(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
}
