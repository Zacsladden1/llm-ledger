# llm-ledger

**Local-first FinOps ledger for AI contractors.**

Import provider usage CSVs (OpenAI, Anthropic, OpenRouter) into a local SQLite database and query spend, budgets, and invoice-style summaries through MCP tools — from Cursor, Claude Desktop, or any MCP client.

This is **not** an LLM gateway. It does not proxy prompts or hold API keys for model calls. It tracks cost after the fact.

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
| `spend_this_month` | Total spend for current month (or `YYYY-MM`) |
| `spend_by_project` | Spend breakdown by project |
| `invoice_summary` | Lines by provider + model (+ project) |
| `set_budget` | Set monthly USD budget for a project |
| `check_budget` | Compare MTD spend vs budget |
| `list_imports` | List import batches |

### CSV columns (resilient aliases)

Importers tolerate common export header names. Cost is optional — when missing, a built-in pricing fallback map estimates USD from tokens.

**OpenAI** — `date` / `usage_date` / `timestamp`, `model`, `input_tokens` / `prompt_tokens`, `output_tokens` / `completion_tokens`, optional `cost` / `cost_usd`, optional `project`.

**Anthropic** — `date` / `created_at`, `model`, `input_tokens` / `tokens_input`, `output_tokens` / `tokens_output`, optional `cost` / `spend`, optional `project` / `workspace`.

**OpenRouter** — `date` / `created_at` / `generation_time`, `model`, `prompt_tokens` / `input_tokens`, `completion_tokens` / `output_tokens`, optional `cost`, optional `project` / `app`.

## Database

- Default path: `~/.llm-ledger/ledger.db`
- Override with env `LLM_LEDGER_DB=/path/to/ledger.db`

No cloud sync. No telemetry. No secrets stored.

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

After `npm run build`, you can also use the bin:

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

(when published), or point `command` at `./dist/index.js` via `node`.

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
npm test        # vitest (CSV parse + aggregation)
npm start       # run MCP server on stdio
```

## Example flow

1. Export usage CSV from OpenAI / Anthropic / OpenRouter.
2. Ask your MCP client: *Import this OpenAI CSV tagged as project `acme`.*
3. *Set budget for acme to $150/month.*
4. *Check budget for acme.* / *Invoice summary for September.*

## License

MIT — see [LICENSE](./LICENSE).

## Attribution

Built as an open-source TypeScript MCP server using [@modelcontextprotocol/sdk](https://github.com/modelcontextprotocol/typescript-sdk), [better-sqlite3](https://github.com/WiseLibs/better-sqlite3), and [csv-parse](https://github.com/adaltas/node-csv).

Pricing fallbacks are approximate public list rates and may drift — prefer CSVs that include USD cost when accuracy matters.
