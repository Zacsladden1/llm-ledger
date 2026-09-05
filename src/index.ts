#!/usr/bin/env node
/**
 * llm-ledger — local-first FinOps MCP server (stdio).
 * Not an LLM gateway: imports provider usage CSVs / OpenRouter activity into SQLite
 * and exposes spend tools.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { defaultDbPath, openDb } from "./db.js";
import {
  handleImportCsv,
  handleSyncOpenrouter,
  handleSpendThisMonth,
  handleSpendByProject,
  handleInvoiceSummary,
  handleSetBudget,
  handleCheckBudget,
  handleListImports,
} from "./tools/handlers.js";

const dbPath = defaultDbPath();
const db = openDb(dbPath);

const server = new McpServer({
  name: "llm-ledger",
  version: "0.2.0",
});

function jsonResult(data: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(data, null, 2),
      },
    ],
  };
}

function errorResult(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return {
    isError: true,
    content: [{ type: "text" as const, text: message }],
  };
}

server.tool(
  "import_csv",
  "Import a provider usage CSV into the local ledger. Providers: openai, anthropic, openrouter. Pass file_path and/or csv_text. Optional project tags all rows.",
  {
    provider: z.enum(["openai", "anthropic", "openrouter"]),
    file_path: z
      .string()
      .describe("Path to CSV on disk (optional if csv_text is provided)"),
    csv_text: z
      .string()
      .optional()
      .describe("Raw CSV contents (optional if file_path is readable)"),
    project: z
      .string()
      .optional()
      .describe("Override project tag applied to all imported rows"),
  },
  async (args) => {
    try {
      if (!args.file_path && !args.csv_text) {
        throw new Error("Provide file_path and/or csv_text");
      }
      return jsonResult(
        handleImportCsv(db, {
          provider: args.provider,
          file_path: args.file_path || "inline.csv",
          csv_text: args.csv_text,
          project: args.project,
        })
      );
    } catch (err) {
      return errorResult(err);
    }
  }
);

server.tool(
  "sync_openrouter",
  "Sync OpenRouter spend from GET /api/v1/activity into the ledger (last ~30 UTC days). Requires a Management API key via env OPENROUTER_MANAGEMENT_KEY or optional api_key arg (never logged). Inference keys return 401/403. Idempotent on day+model+endpoint.",
  {
    api_key: z
      .string()
      .optional()
      .describe(
        "Optional Management API key override. Prefer OPENROUTER_MANAGEMENT_KEY env. Never echoed in results."
      ),
    project: z
      .string()
      .optional()
      .describe("Optional project tag applied to all synced rows"),
    since: z
      .string()
      .optional()
      .describe("Inclusive lower bound YYYY-MM-DD (client-side filter)"),
    until: z
      .string()
      .optional()
      .describe("Inclusive upper bound YYYY-MM-DD (client-side filter)"),
    date: z
      .string()
      .optional()
      .describe("Single UTC date YYYY-MM-DD passed to the activity API"),
    workspace_id: z
      .string()
      .optional()
      .describe("Filter activity to a workspace UUID"),
    group_by_workspace: z
      .boolean()
      .optional()
      .describe("Split rows per workspace (adds workspace_id to each item)"),
  },
  async (args) => {
    try {
      // api_key is used only for Authorization; response never includes it.
      return jsonResult(await handleSyncOpenrouter(db, args));
    } catch (err) {
      return errorResult(err);
    }
  }
);

server.tool(
  "spend_this_month",
  "Total spend for the current calendar month (or a given YYYY-MM). Optionally filter by project.",
  {
    project: z.string().optional(),
    month: z
      .string()
      .optional()
      .describe("YYYY-MM; defaults to current month"),
  },
  async (args) => {
    try {
      return jsonResult(handleSpendThisMonth(db, args));
    } catch (err) {
      return errorResult(err);
    }
  }
);

server.tool(
  "spend_by_project",
  "Break down spend by project for the current month (or YYYY-MM).",
  {
    month: z.string().optional().describe("YYYY-MM; defaults to current month"),
  },
  async (args) => {
    try {
      return jsonResult(handleSpendByProject(db, args));
    } catch (err) {
      return errorResult(err);
    }
  }
);

server.tool(
  "invoice_summary",
  "Invoice-style lines grouped by provider + model (+ project) for a month.",
  {
    month: z.string().optional().describe("YYYY-MM; defaults to current month"),
    project: z.string().optional(),
  },
  async (args) => {
    try {
      return jsonResult(handleInvoiceSummary(db, args));
    } catch (err) {
      return errorResult(err);
    }
  }
);

server.tool(
  "set_budget",
  "Set a monthly USD budget ceiling for a project.",
  {
    project: z.string(),
    monthly_limit_usd: z.number().nonnegative(),
  },
  async (args) => {
    try {
      return jsonResult(handleSetBudget(db, args));
    } catch (err) {
      return errorResult(err);
    }
  }
);

server.tool(
  "check_budget",
  "Compare month-to-date spend for a project against its budget.",
  {
    project: z.string(),
    month: z.string().optional().describe("YYYY-MM; defaults to current month"),
  },
  async (args) => {
    try {
      return jsonResult(handleCheckBudget(db, args));
    } catch (err) {
      return errorResult(err);
    }
  }
);

server.tool(
  "list_imports",
  "List CSV / OpenRouter sync import batches recorded in the ledger.",
  {},
  async () => {
    try {
      return jsonResult(handleListImports(db));
    } catch (err) {
      return errorResult(err);
    }
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`llm-ledger MCP server ready (db=${dbPath})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
