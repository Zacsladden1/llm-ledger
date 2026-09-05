import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb, listImports, spendInRange } from "../src/db.js";
import {
  handleSyncOpenrouter,
  handleListImports,
} from "../src/tools/handlers.js";
import {
  activityDedupeKey,
  buildActivityUrl,
  mapActivityItem,
  mapActivityItems,
  resolveManagementKey,
  type OpenRouterActivityItem,
} from "../src/openrouter/activity.js";

const SAMPLE: OpenRouterActivityItem[] = [
  {
    date: "2026-08-24",
    model: "openai/gpt-4.1",
    model_permaslug: "openai/gpt-4.1-2025-04-14",
    endpoint_id: "550e8400-e29b-41d4-a716-446655440000",
    provider_name: "OpenAI",
    usage: 0.015,
    byok_usage_inference: 0.012,
    requests: 5,
    prompt_tokens: 50,
    completion_tokens: 125,
    reasoning_tokens: 25,
  },
  {
    date: "2026-08-25",
    model: "anthropic/claude-3.5-sonnet",
    model_permaslug: "anthropic/claude-3.5-sonnet",
    endpoint_id: "660e8400-e29b-41d4-a716-446655440001",
    provider_name: "Anthropic",
    usage: 1.25,
    byok_usage_inference: 0,
    requests: 2,
    prompt_tokens: 1000,
    completion_tokens: 500,
    reasoning_tokens: 0,
    workspace_id: "ws-acme",
  },
];

function mockFetchOk(data: OpenRouterActivityItem[]): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    expect(url).toContain("https://openrouter.ai/api/v1/activity");
    const auth = (init?.headers as Record<string, string>)?.Authorization;
    expect(auth).toMatch(/^Bearer /);
    expect(auth).not.toContain("undefined");
    return {
      ok: true,
      status: 200,
      json: async () => ({ data }),
    } as Response;
  }) as typeof fetch;
}

describe("openrouter activity mapping", () => {
  it("builds activity URL with filters", () => {
    const url = buildActivityUrl({
      date: "2026-08-24",
      groupByWorkspace: true,
      workspaceId: "ws-1",
    });
    expect(url).toContain("date=2026-08-24");
    expect(url).toContain("group_by=workspace");
    expect(url).toContain("workspace_id=ws-1");
  });

  it("maps activity rows into ledger shape", () => {
    const row = mapActivityItem(SAMPLE[0], "client-a");
    expect(row).toMatchObject({
      provider: "openrouter",
      model: "openai/gpt-4.1",
      project: "client-a",
      usage_date: "2026-08-24",
      input_tokens: 50,
      output_tokens: 125,
      total_tokens: 200,
      cost_usd: 0.015,
      raw_cost_present: true,
    });
    expect(row!.dedupe_key).toBe(activityDedupeKey(SAMPLE[0]));
  });

  it("uses workspace_id as project when no override", () => {
    const row = mapActivityItem(SAMPLE[1]);
    expect(row!.project).toBe("ws-acme");
    expect(row!.dedupe_key).toContain(":ws:ws-acme");
  });

  it("filters by since/until", () => {
    const mapped = mapActivityItems(SAMPLE, {
      since: "2026-08-25",
      until: "2026-08-25",
    });
    expect(mapped).toHaveLength(1);
    expect(mapped[0].model).toBe("anthropic/claude-3.5-sonnet");
  });

  it("resolveManagementKey prefers arg then env", () => {
    expect(resolveManagementKey(" arg-key ", {})).toBe("arg-key");
    expect(
      resolveManagementKey(undefined, {
        OPENROUTER_MANAGEMENT_KEY: " env-key ",
      })
    ).toBe("env-key");
    expect(() => resolveManagementKey(undefined, {})).toThrow(
      /OPENROUTER_MANAGEMENT_KEY/
    );
  });
});

describe("sync_openrouter handler", () => {
  let dbPath: string;
  let db: ReturnType<typeof openDb>;
  const prevKey = process.env.OPENROUTER_MANAGEMENT_KEY;

  beforeEach(() => {
    dbPath = path.join(
      os.tmpdir(),
      `llm-ledger-or-${Date.now()}-${Math.random().toString(16).slice(2)}.db`
    );
    db = openDb(dbPath);
    process.env.OPENROUTER_MANAGEMENT_KEY = "test-mgmt-key-not-a-secret";
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
    if (prevKey === undefined) delete process.env.OPENROUTER_MANAGEMENT_KEY;
    else process.env.OPENROUTER_MANAGEMENT_KEY = prevKey;
  });

  it("imports activity rows and records an import batch", async () => {
    const result = (await handleSyncOpenrouter(db, {
      project: "acme",
      fetchImpl: mockFetchOk(SAMPLE),
    })) as {
      ok: boolean;
      imported: number;
      skipped_duplicates: number;
      import_id: number;
      activity_cost_usd: number;
      api_key?: string;
    };

    expect(result.ok).toBe(true);
    expect(result.imported).toBe(2);
    expect(result.skipped_duplicates).toBe(0);
    expect(result.activity_cost_usd).toBeCloseTo(1.265, 5);
    expect(result.api_key).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain("test-mgmt-key");

    const spend = spendInRange(db, "2026-08-01", "2026-09-01", "acme");
    expect(spend.rows).toBe(2);
    expect(spend.cost_usd).toBeCloseTo(1.265, 5);

    const imports = listImports(db);
    expect(imports).toHaveLength(1);
    expect(imports[0].provider).toBe("openrouter");
    expect(imports[0].filename).toContain("openrouter-activity:");
    expect(imports[0].row_count).toBe(2);

    const listed = handleListImports(db) as { imports: unknown[] };
    expect(listed.imports).toHaveLength(1);
  });

  it("is idempotent — second sync skips duplicates", async () => {
    const fetchImpl = mockFetchOk(SAMPLE);
    const first = (await handleSyncOpenrouter(db, {
      fetchImpl,
    })) as { imported: number; skipped_duplicates: number };
    expect(first.imported).toBe(2);

    const second = (await handleSyncOpenrouter(db, {
      fetchImpl,
    })) as { imported: number; skipped_duplicates: number; mapped: number };
    expect(second.mapped).toBe(2);
    expect(second.imported).toBe(0);
    expect(second.skipped_duplicates).toBe(2);

    const spend = spendInRange(db, "2026-08-01", "2026-09-01");
    expect(spend.rows).toBe(2);
    expect(spend.cost_usd).toBeCloseTo(1.265, 5);
  });

  it("surfaces 403 management-key guidance without echoing the key", async () => {
    const fetchImpl = (async () =>
      ({
        ok: false,
        status: 403,
        json: async () => ({
          error: {
            code: 403,
            message: "Only management keys can perform this operation",
          },
        }),
      }) as Response) as typeof fetch;

    await expect(
      handleSyncOpenrouter(db, {
        api_key: "sk-or-v1-inference-looking-key",
        fetchImpl,
      })
    ).rejects.toThrow(/Management API key/);

    try {
      await handleSyncOpenrouter(db, {
        api_key: "sk-or-v1-inference-looking-key",
        fetchImpl,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      expect(msg).not.toContain("sk-or-v1-inference-looking-key");
    }
  });

  it("filters with since/until client-side", async () => {
    const result = (await handleSyncOpenrouter(db, {
      since: "2026-08-25",
      until: "2026-08-25",
      fetchImpl: mockFetchOk(SAMPLE),
    })) as { imported: number; mapped: number; fetched: number };
    expect(result.fetched).toBe(2);
    expect(result.mapped).toBe(1);
    expect(result.imported).toBe(1);
  });
});
