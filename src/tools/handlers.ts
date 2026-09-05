import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import {
  insertImport,
  insertUsageBatch,
  insertUsageBatchIdempotent,
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
import {
  fetchOpenRouterActivity,
  mapActivityItems,
  resolveManagementKey,
} from "../openrouter/activity.js";
import {
  fetchOpenAICosts,
  mapCostBuckets,
  resolveAdminKey,
  defaultStartTime,
} from "../openai/costs.js";

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
      dedupe_key: null,
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

export type SyncOpenRouterArgs = {
  /** Optional override; prefer env OPENROUTER_MANAGEMENT_KEY. Never echoed. */
  api_key?: string;
  project?: string;
  /** Client-side inclusive lower bound YYYY-MM-DD. */
  since?: string;
  /** Client-side inclusive upper bound YYYY-MM-DD. */
  until?: string;
  /** Pass-through single-day filter to OpenRouter activity API. */
  date?: string;
  workspace_id?: string;
  group_by_workspace?: boolean;
  /** Injectable fetch for tests. */
  fetchImpl?: typeof fetch;
};

export async function handleSyncOpenrouter(
  db: Database.Database,
  args: SyncOpenRouterArgs = {}
): Promise<object> {
  // Resolve key without ever putting it into the return payload.
  const apiKey = resolveManagementKey(args.api_key);

  if (args.since && !/^\d{4}-\d{2}-\d{2}$/.test(args.since)) {
    throw new Error(`Invalid since "${args.since}"; expected YYYY-MM-DD`);
  }
  if (args.until && !/^\d{4}-\d{2}-\d{2}$/.test(args.until)) {
    throw new Error(`Invalid until "${args.until}"; expected YYYY-MM-DD`);
  }
  if (args.date && !/^\d{4}-\d{2}-\d{2}$/.test(args.date)) {
    throw new Error(`Invalid date "${args.date}"; expected YYYY-MM-DD`);
  }

  const items = await fetchOpenRouterActivity({
    apiKey,
    date: args.date,
    workspaceId: args.workspace_id,
    groupByWorkspace: args.group_by_workspace,
    fetchImpl: args.fetchImpl,
  });

  const projectOverride = args.project?.trim() || null;
  const mapped = mapActivityItems(items, {
    project: projectOverride,
    since: args.since,
    until: args.until,
  });

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const rangeLabel =
    args.date ||
    [args.since || "30d", args.until || "now"].join("..");
  const filename = `openrouter-activity:${rangeLabel}@${stamp}`;

  const importId = insertImport(
    db,
    "openrouter",
    filename,
    projectOverride,
    mapped.length
  );

  const { inserted, skipped } = insertUsageBatchIdempotent(
    db,
    mapped.map((r) => ({
      provider: r.provider,
      model: r.model,
      project: r.project,
      usage_date: r.usage_date,
      input_tokens: r.input_tokens,
      output_tokens: r.output_tokens,
      total_tokens: r.total_tokens,
      cost_usd: r.cost_usd,
      raw_cost_present: r.raw_cost_present ? 1 : 0,
      import_id: importId,
      dedupe_key: r.dedupe_key,
    }))
  );

  // Update import row_count to reflect newly inserted rows.
  db.prepare(`UPDATE imports SET row_count = ? WHERE id = ?`).run(
    inserted,
    importId
  );

  const activityCost = mapped.reduce((s, r) => s + r.cost_usd, 0);

  return {
    ok: true,
    import_id: importId,
    provider: "openrouter",
    source: "activity",
    filename,
    fetched: items.length,
    mapped: mapped.length,
    imported: inserted,
    skipped_duplicates: skipped,
    activity_cost_usd: roundMoney(activityCost),
    // Explicitly do not include api_key or Authorization material.
    note:
      "Idempotent on day+model+endpoint(+workspace). Re-running skips duplicates.",
  };
}

export type SyncOpenAIArgs = {
  /** Optional override; prefer env OPENAI_ADMIN_KEY. Never echoed. */
  api_key?: string;
  project?: string;
  /** Client-side inclusive lower bound YYYY-MM-DD. */
  since?: string;
  /** Client-side inclusive upper bound YYYY-MM-DD. */
  until?: string;
  /** Unix seconds inclusive start for Costs API (default ~30 days ago). */
  start_time?: number;
  /** Unix seconds exclusive end. */
  end_time?: number;
  /** Buckets to return (1–180); default 30. */
  limit?: number;
  /** Injectable fetch for tests. */
  fetchImpl?: typeof fetch;
};

export async function handleSyncOpenai(
  db: Database.Database,
  args: SyncOpenAIArgs = {}
): Promise<object> {
  // Prefer env OPENAI_ADMIN_KEY; never put the key into the return payload.
  const apiKey = resolveAdminKey(args.api_key);

  if (args.since && !/^\d{4}-\d{2}-\d{2}$/.test(args.since)) {
    throw new Error(`Invalid since "${args.since}"; expected YYYY-MM-DD`);
  }
  if (args.until && !/^\d{4}-\d{2}-\d{2}$/.test(args.until)) {
    throw new Error(`Invalid until "${args.until}"; expected YYYY-MM-DD`);
  }
  if (
    args.limit !== undefined &&
    (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 180)
  ) {
    throw new Error(`Invalid limit "${args.limit}"; expected integer 1–180`);
  }

  const startTime =
    typeof args.start_time === "number" && Number.isFinite(args.start_time)
      ? Math.floor(args.start_time)
      : defaultStartTime();

  const buckets = await fetchOpenAICosts({
    apiKey,
    startTime,
    endTime: args.end_time,
    limit: args.limit ?? 30,
    groupBy: ["line_item", "project_id"],
    fetchImpl: args.fetchImpl,
  });

  const projectOverride = args.project?.trim() || null;
  const mapped = mapCostBuckets(buckets, {
    project: projectOverride,
    since: args.since,
    until: args.until,
  });

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const rangeLabel = [args.since || "30d", args.until || "now"].join("..");
  const filename = `openai-costs:${rangeLabel}@${stamp}`;

  const importId = insertImport(
    db,
    "openai",
    filename,
    projectOverride,
    mapped.length
  );

  const { inserted, skipped } = insertUsageBatchIdempotent(
    db,
    mapped.map((r) => ({
      provider: r.provider,
      model: r.model,
      project: r.project,
      usage_date: r.usage_date,
      input_tokens: r.input_tokens,
      output_tokens: r.output_tokens,
      total_tokens: r.total_tokens,
      cost_usd: r.cost_usd,
      raw_cost_present: r.raw_cost_present ? 1 : 0,
      import_id: importId,
      dedupe_key: r.dedupe_key,
    }))
  );

  db.prepare(`UPDATE imports SET row_count = ? WHERE id = ?`).run(
    inserted,
    importId
  );

  const costsTotal = mapped.reduce((s, r) => s + r.cost_usd, 0);

  return {
    ok: true,
    import_id: importId,
    provider: "openai",
    source: "costs",
    filename,
    fetched_buckets: buckets.length,
    mapped: mapped.length,
    imported: inserted,
    skipped_duplicates: skipped,
    costs_usd: roundMoney(costsTotal),
    // Explicitly do not include api_key or Authorization material.
    note:
      "Idempotent on day+line_item(+project). Costs-only (tokens=0). Re-running skips duplicates.",
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
  const over = limit === null ? false : spent.cost_usd > limit;
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
