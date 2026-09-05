import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  openDb,
  insertImport,
  insertUsageBatch,
  spendInRange,
  spendByProject,
  invoiceSummary,
  setBudget,
  getBudget,
} from "../src/db.js";
import {
  handleImportCsv,
  handleSpendThisMonth,
  handleCheckBudget,
  handleInvoiceSummary,
} from "../src/tools/handlers.js";
import { monthBounds } from "../src/dates.js";

describe("aggregation", () => {
  let dbPath: string;
  let db: ReturnType<typeof openDb>;

  beforeEach(() => {
    dbPath = path.join(
      os.tmpdir(),
      `llm-ledger-test-${Date.now()}-${Math.random().toString(16).slice(2)}.db`
    );
    db = openDb(dbPath);
  });

  afterEach(() => {
    db.close();
    for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
      try {
        fs.unlinkSync(p);
      } catch {
        /* ignore */
      }
    }
  });

  it("sums spend in range and by project", () => {
    const importId = insertImport(db, "openai", "a.csv", null, 2);
    insertUsageBatch(db, [
      {
        provider: "openai",
        model: "gpt-4o",
        project: "alpha",
        usage_date: "2026-09-01",
        input_tokens: 10,
        output_tokens: 5,
        total_tokens: 15,
        cost_usd: 1.25,
        raw_cost_present: 1,
        import_id: importId,
      },
      {
        provider: "anthropic",
        model: "claude-3-5-haiku",
        project: "beta",
        usage_date: "2026-09-02",
        input_tokens: 20,
        output_tokens: 10,
        total_tokens: 30,
        cost_usd: 0.75,
        raw_cost_present: 1,
        import_id: importId,
      },
      {
        provider: "openai",
        model: "gpt-4o-mini",
        project: "alpha",
        usage_date: "2026-08-31",
        input_tokens: 1,
        output_tokens: 1,
        total_tokens: 2,
        cost_usd: 9.99,
        raw_cost_present: 1,
        import_id: importId,
      },
    ]);

    const month = spendInRange(db, "2026-09-01", "2026-10-01");
    expect(month.cost_usd).toBeCloseTo(2.0, 5);
    expect(month.rows).toBe(2);

    const byProject = spendByProject(db, "2026-09-01", "2026-10-01");
    expect(byProject).toHaveLength(2);
    expect(byProject[0].project).toBe("alpha");
    expect(byProject[0].cost_usd).toBeCloseTo(1.25, 5);

    const invoice = invoiceSummary(db, "2026-09-01", "2026-10-01", "alpha");
    expect(invoice).toHaveLength(1);
    expect(invoice[0].model).toBe("gpt-4o");
  });

  it("imports CSV via handler and checks budget", () => {
    const csv =
      "date,model,input_tokens,output_tokens,cost_usd,project\n" +
      "2026-09-03,gpt-4o-mini,100,50,12.5,client-a\n" +
      "2026-09-04,gpt-4o-mini,100,50,7.5,client-a\n";

    const result = handleImportCsv(db, {
      provider: "openai",
      file_path: "inline.csv",
      csv_text: csv,
    }) as { ok: boolean; imported: number; total_cost_usd: number };

    expect(result.ok).toBe(true);
    expect(result.imported).toBe(2);
    expect(result.total_cost_usd).toBeCloseTo(20, 5);

    setBudget(db, "client-a", 15);
    expect(getBudget(db, "client-a")?.monthly_limit_usd).toBe(15);

    const check = handleCheckBudget(db, {
      project: "client-a",
      month: "2026-09",
    }) as {
      spent_usd: number;
      over_budget: boolean;
      remaining_usd: number;
    };
    expect(check.spent_usd).toBeCloseTo(20, 5);
    expect(check.over_budget).toBe(true);
    expect(check.remaining_usd).toBeCloseTo(-5, 5);

    const spend = handleSpendThisMonth(db, {
      project: "client-a",
      month: "2026-09",
    }) as { cost_usd: number };
    expect(spend.cost_usd).toBeCloseTo(20, 5);

    const inv = handleInvoiceSummary(db, {
      month: "2026-09",
      project: "client-a",
    }) as { total_cost_usd: number; lines: unknown[] };
    expect(inv.total_cost_usd).toBeCloseTo(20, 5);
    expect(inv.lines.length).toBeGreaterThan(0);
  });

  it("monthBounds returns YYYY-MM-DD strings", () => {
    const { start, end } = monthBounds(new Date("2026-09-05T12:00:00"));
    expect(start).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(end).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
