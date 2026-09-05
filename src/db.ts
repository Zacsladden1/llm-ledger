import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type UsageRow = {
  id?: number;
  provider: string;
  model: string;
  project: string | null;
  usage_date: string;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cost_usd: number;
  raw_cost_present: number;
  import_id: number;
  dedupe_key?: string | null;
  created_at?: string;
};

export type ImportRow = {
  id: number;
  provider: string;
  filename: string;
  project: string | null;
  row_count: number;
  imported_at: string;
};

export type BudgetRow = {
  project: string;
  monthly_limit_usd: number;
  updated_at: string;
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS imports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL,
  filename TEXT NOT NULL,
  project TEXT,
  row_count INTEGER NOT NULL DEFAULT 0,
  imported_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  project TEXT,
  usage_date TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  raw_cost_present INTEGER NOT NULL DEFAULT 0,
  import_id INTEGER NOT NULL REFERENCES imports(id) ON DELETE CASCADE,
  dedupe_key TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_usage_date ON usage(usage_date);
CREATE INDEX IF NOT EXISTS idx_usage_project ON usage(project);
CREATE INDEX IF NOT EXISTS idx_usage_provider ON usage(provider);
CREATE INDEX IF NOT EXISTS idx_usage_import ON usage(import_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_usage_dedupe
  ON usage(dedupe_key) WHERE dedupe_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS budgets (
  project TEXT PRIMARY KEY,
  monthly_limit_usd REAL NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

function migrate(db: Database.Database): void {
  const cols = db
    .prepare(`PRAGMA table_info(usage)`)
    .all() as Array<{ name: string }>;
  const names = new Set(cols.map((c) => c.name));
  if (!names.has("dedupe_key")) {
    db.exec(`ALTER TABLE usage ADD COLUMN dedupe_key TEXT`);
  }
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_usage_dedupe
      ON usage(dedupe_key) WHERE dedupe_key IS NOT NULL
  `);
}

export function defaultDbPath(): string {
  const override = process.env.LLM_LEDGER_DB;
  if (override && override.trim()) return override.trim();
  return path.join(os.homedir(), ".llm-ledger", "ledger.db");
}

export function openDb(dbPath = defaultDbPath()): Database.Database {
  const dir = path.dirname(dbPath);
  fs.mkdirSync(dir, { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

export function insertImport(
  db: Database.Database,
  provider: string,
  filename: string,
  project: string | null,
  rowCount: number
): number {
  const info = db
    .prepare(
      `INSERT INTO imports (provider, filename, project, row_count)
       VALUES (?, ?, ?, ?)`
    )
    .run(provider, filename, project, rowCount);
  return Number(info.lastInsertRowid);
}

export function insertUsageBatch(
  db: Database.Database,
  rows: Omit<UsageRow, "id" | "created_at">[]
): void {
  const stmt = db.prepare(
    `INSERT INTO usage (
      provider, model, project, usage_date,
      input_tokens, output_tokens, total_tokens,
      cost_usd, raw_cost_present, import_id, dedupe_key
    ) VALUES (
      @provider, @model, @project, @usage_date,
      @input_tokens, @output_tokens, @total_tokens,
      @cost_usd, @raw_cost_present, @import_id, @dedupe_key
    )`
  );
  const tx = db.transaction((batch: typeof rows) => {
    for (const row of batch) {
      stmt.run({
        ...row,
        dedupe_key: row.dedupe_key ?? null,
      });
    }
  });
  tx(rows);
}

/**
 * Insert usage rows, skipping any whose dedupe_key already exists.
 * Returns counts of inserted vs skipped.
 */
export function insertUsageBatchIdempotent(
  db: Database.Database,
  rows: Omit<UsageRow, "id" | "created_at">[]
): { inserted: number; skipped: number } {
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO usage (
      provider, model, project, usage_date,
      input_tokens, output_tokens, total_tokens,
      cost_usd, raw_cost_present, import_id, dedupe_key
    ) VALUES (
      @provider, @model, @project, @usage_date,
      @input_tokens, @output_tokens, @total_tokens,
      @cost_usd, @raw_cost_present, @import_id, @dedupe_key
    )`
  );
  let inserted = 0;
  let skipped = 0;
  const tx = db.transaction((batch: typeof rows) => {
    for (const row of batch) {
      const info = stmt.run({
        ...row,
        dedupe_key: row.dedupe_key ?? null,
      });
      if (info.changes > 0) inserted += 1;
      else skipped += 1;
    }
  });
  tx(rows);
  return { inserted, skipped };
}

export function listImports(db: Database.Database): ImportRow[] {
  return db
    .prepare(
      `SELECT id, provider, filename, project, row_count, imported_at
       FROM imports ORDER BY imported_at DESC, id DESC`
    )
    .all() as ImportRow[];
}

export function setBudget(
  db: Database.Database,
  project: string,
  monthlyLimitUsd: number
): void {
  db.prepare(
    `INSERT INTO budgets (project, monthly_limit_usd, updated_at)
     VALUES (?, ?, datetime('now'))
     ON CONFLICT(project) DO UPDATE SET
       monthly_limit_usd = excluded.monthly_limit_usd,
       updated_at = datetime('now')`
  ).run(project, monthlyLimitUsd);
}

export function getBudget(
  db: Database.Database,
  project: string
): BudgetRow | undefined {
  return db
    .prepare(
      `SELECT project, monthly_limit_usd, updated_at FROM budgets WHERE project = ?`
    )
    .get(project) as BudgetRow | undefined;
}

export function spendInRange(
  db: Database.Database,
  startDate: string,
  endDate: string,
  project?: string | null
): { cost_usd: number; rows: number; input_tokens: number; output_tokens: number } {
  const row = project
    ? (db
        .prepare(
          `SELECT
             COALESCE(SUM(cost_usd), 0) AS cost_usd,
             COUNT(*) AS rows,
             COALESCE(SUM(input_tokens), 0) AS input_tokens,
             COALESCE(SUM(output_tokens), 0) AS output_tokens
           FROM usage
           WHERE usage_date >= ? AND usage_date < ?
             AND project = ?`
        )
        .get(startDate, endDate, project) as {
        cost_usd: number;
        rows: number;
        input_tokens: number;
        output_tokens: number;
      })
    : (db
        .prepare(
          `SELECT
             COALESCE(SUM(cost_usd), 0) AS cost_usd,
             COUNT(*) AS rows,
             COALESCE(SUM(input_tokens), 0) AS input_tokens,
             COALESCE(SUM(output_tokens), 0) AS output_tokens
           FROM usage
           WHERE usage_date >= ? AND usage_date < ?`
        )
        .get(startDate, endDate) as {
        cost_usd: number;
        rows: number;
        input_tokens: number;
        output_tokens: number;
      });
  return row;
}

export function spendByProject(
  db: Database.Database,
  startDate: string,
  endDate: string
): Array<{
  project: string;
  cost_usd: number;
  rows: number;
  input_tokens: number;
  output_tokens: number;
}> {
  return db
    .prepare(
      `SELECT
         COALESCE(project, '(none)') AS project,
         COALESCE(SUM(cost_usd), 0) AS cost_usd,
         COUNT(*) AS rows,
         COALESCE(SUM(input_tokens), 0) AS input_tokens,
         COALESCE(SUM(output_tokens), 0) AS output_tokens
       FROM usage
       WHERE usage_date >= ? AND usage_date < ?
       GROUP BY COALESCE(project, '(none)')
       ORDER BY cost_usd DESC`
    )
    .all(startDate, endDate) as Array<{
    project: string;
    cost_usd: number;
    rows: number;
    input_tokens: number;
    output_tokens: number;
  }>;
}

export function invoiceSummary(
  db: Database.Database,
  startDate: string,
  endDate: string,
  project?: string | null
): Array<{
  provider: string;
  model: string;
  project: string;
  cost_usd: number;
  input_tokens: number;
  output_tokens: number;
  rows: number;
}> {
  if (project) {
    return db
      .prepare(
        `SELECT
           provider,
           model,
           COALESCE(project, '(none)') AS project,
           COALESCE(SUM(cost_usd), 0) AS cost_usd,
           COALESCE(SUM(input_tokens), 0) AS input_tokens,
           COALESCE(SUM(output_tokens), 0) AS output_tokens,
           COUNT(*) AS rows
         FROM usage
         WHERE usage_date >= ? AND usage_date < ?
           AND project = ?
         GROUP BY provider, model, COALESCE(project, '(none)')
         ORDER BY cost_usd DESC`
      )
      .all(startDate, endDate, project) as Array<{
      provider: string;
      model: string;
      project: string;
      cost_usd: number;
      input_tokens: number;
      output_tokens: number;
      rows: number;
    }>;
  }
  return db
    .prepare(
      `SELECT
         provider,
         model,
         COALESCE(project, '(none)') AS project,
         COALESCE(SUM(cost_usd), 0) AS cost_usd,
         COALESCE(SUM(input_tokens), 0) AS input_tokens,
         COALESCE(SUM(output_tokens), 0) AS output_tokens,
         COUNT(*) AS rows
       FROM usage
       WHERE usage_date >= ? AND usage_date < ?
       GROUP BY provider, model, COALESCE(project, '(none)')
       ORDER BY cost_usd DESC`
    )
    .all(startDate, endDate) as Array<{
    provider: string;
    model: string;
    project: string;
    cost_usd: number;
    input_tokens: number;
    output_tokens: number;
    rows: number;
  }>;
}
