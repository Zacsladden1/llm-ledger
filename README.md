# llm-ledger

**Local-first FinOps ledger for AI contractors.**

Import provider usage CSVs (OpenAI, Anthropic, OpenRouter) — or sync OpenRouter Activity / OpenAI Organization Costs into a local SQLite database — and query spend, budgets, and invoice-style summaries through MCP tools — from Cursor, Claude Desktop, or any MCP client.

This is **not** an LLM gateway. It does not proxy prompts. OpenRouter sync needs a **Management API key**; OpenAI costs sync needs an **Admin API key** (regular `sk-` keys will not work). Keys are only used at sync time and are never stored in the ledger.

## Why

Freelancers and small agencies juggling multiple AI providers need a single place to answer:

- How much did I spend this month?
- Which client/project ate the budget?
- Am I over the retainer ceiling?
- What would an invoice line-item look like by model?

`llm-ledger` keeps that data on your machine (`~/.llm-ledger/ledger.db` by default).

## Install

```bash
git clone https://github.com/Zacsladden1/llm-ledger.git
cd llm-ledger
npm install
npm run build
```

Requires **Node.js 20+**. Native module `better-sqlite3` needs build tools on some platforms (Xcode CLT on macOS, `build-essential` + python on Linux).

## MCP tools

| Tool | Purpose |
|------|---------|
| `import_csv` | Import a usage CSV (`openai` / `anthropic` / `openrouter`) |
| `sync_openrouter` | Pull OpenRouter Activity API spend (Management key) into the ledger |
| `sync_openai` | Pull OpenAI Organization Costs API spend (Admin key) into the ledger |
| `spend_this_month` | Total spend for current month (or `YYYY-MM`) |
| `spend_by_project` | Spend breakdown by project |
| `invoice_summary` | Lines by provider + model (+ project) |
| `set_budget` | Set monthly USD budget for a project |
| `check_budget` | Compare MTD spend vs budget |
| `list_imports` | List CSV / OpenRouter / OpenAI sync import batches |

### CSV columns (resilient aliases)

Importers tolerate common export header names. Cost is optional — when missing, a built-in pricing fallback map estimates USD from tokens.

**OpenAI** — `date` / `usage_date` / `timestamp`, `model`, `input_tokens` / `prompt_tokens`, `output_tokens` / `completion_tokens`, optional `cost` / `cost_usd`, optional `project`.

**Anthropic** — `date` / `created_at`, `model`, `input_tokens` / `tokens_input`, `output_tokens` / `tokens_output`, optional `cost` / `spend`, optional `project` / `workspace`.

**OpenRouter** — `date` / `created_at` / `generation_time`, `model`, `prompt_tokens` / `input_tokens`, `completion_tokens` / `output_tokens`, optional `cost`, optional `project` / `app`.

## Database

- Default path: `~/.llm-ledger/ledger.db`
- Override with env `LLM_LEDGER_DB=/path/to/ledger.db`

No cloud sync of the ledger itself. No telemetry. API keys are read from the environment (or an optional tool arg) at sync time and are **not** written to SQLite.

## OpenRouter Activity sync (`sync_openrouter`)

OpenRouter's `/api/v1/activity` (and analytics) endpoints require a **Management API key** (also called a provisioning key). Ordinary inference / chat keys return **401/403**.

1. Create a Management key at [openrouter.ai/settings](https://openrouter.ai/settings) → **Management Keys** ([direct link](https://openrouter.ai/settings/management-keys)).
2. Set env `OPENROUTER_MANAGEMENT_KEY` in your MCP server config (preferred), **or** pass `api_key` to the tool once (never logged or echoed in tool results).
3. Ask your MCP client, e.g. *"Sync OpenRouter last 30 days"* / call `sync_openrouter` with optional `since` / `until` (`YYYY-MM-DD`) or `project`.

Example Cursor `env` block:

```json
{
  "mcpServers": {
    "llm-ledger": {
      "command": "node",
      "args": ["/absolute/path/to/llm-ledger/dist/index.js"],
      "env": {
        "LLM_LEDGER_DB": "/absolute/path/to/optional-custom.db",
        "OPENROUTER_MANAGEMENT_KEY": "sk-or-…"
      }
    }
  }
}
```

Sync is **idempotent**: rows are keyed by day + model + endpoint (+ workspace when present), so re-running skips duplicates and records an import batch visible via `list_imports`. The Activity API covers roughly the last 30 completed UTC days.


## OpenAI Costs sync (`sync_openai`)

OpenAI's `/v1/organization/costs` endpoint requires an **Organization Admin API key**. Regular project `sk-` inference keys **will not work**.

1. Create an Admin key at [platform.openai.com/settings/organization/admin-keys](https://platform.openai.com/settings/organization/admin-keys).
2. Set env `OPENAI_ADMIN_KEY` in your MCP server config (preferred), **or** pass `api_key` to the tool once (never logged or echoed in tool results).
3. Ask your MCP client, e.g. *"Sync OpenAI last 30 days"* / call `sync_openai` with optional `since` / `until` (`YYYY-MM-DD`), `start_time` (unix), `limit` (1–180), or `project`.

Example Cursor `env` block (combined with OpenRouter):

```json
{
  "mcpServers": {
    "llm-ledger": {
      "command": "node",
      "args": ["/absolute/path/to/llm-ledger/dist/index.js"],
      "env": {
        "LLM_LEDGER_DB": "/absolute/path/to/optional-custom.db",
        "OPENROUTER_MANAGEMENT_KEY": "sk-or-…",
        "OPENAI_ADMIN_KEY": "sk-admin-…"
      }
    }
  }
}
```

Sync is **idempotent**: rows are keyed as `oai:costs:{date}:{line_item|project|bucket}` (day + line item + project when present). v0.3 is **costs-only** (token columns are 0). Import batches appear in `list_imports`.

## Cursor config

Add to your MCP settings (e.g. Cursor **Settings → MCP**):

```json
{
  "mcpServers": {
    "llm-ledger": {
      "command": "node",
      "args": ["/absolute/path/to/llm-ledger/dist/index.js"],
      "env": {
        "LLM_LEDGER_DB": "/absolute/path/to/optional-custom.db"
      }
    }
  }
}
```

### npx (once on the public registry)

```json
{
  "mcpServers": {
    "llm-ledger": {
      "command": "npx",
      "args": ["--yes", "llm-ledger"]
    }
  }
}
```

Or after a local build, point command at node with args to dist/index.js. See PUBLISH.md for registry release steps.

## Claude Desktop config

Edit `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "llm-ledger": {
      "command": "node",
      "args": ["/absolute/path/to/llm-ledger/dist/index.js"]
    }
  }
}
```

## Scripts

```bash
npm run build   # compile TypeScript → dist/
npm test        # vitest (CSV parse + aggregation + sync mocks)
npm start       # run MCP server on stdio
```

## Example flow

1. Export usage CSV from OpenAI / Anthropic / OpenRouter, **or** set the env var and call the sync tool for the last 30 days.
2. Ask your MCP client: *Import this OpenAI CSV tagged as project `acme`.*
3. *Set budget for acme to $150/month.*
4. *Check budget for acme.* / *Invoice summary for September.*

## License

MIT — see [LICENSE](./LICENSE).

## Attribution

Built as an open-source TypeScript MCP server using [@modelcontextprotocol/sdk](https://github.com/modelcontextprotocol/typescript-sdk), [better-sqlite3](https://github.com/WiseLibs/better-sqlite3), and [csv-parse](https://github.com/adaltas/node-csv).

Pricing fallbacks are approximate public list rates and may drift — prefer CSVs that include USD cost when accuracy matters.
