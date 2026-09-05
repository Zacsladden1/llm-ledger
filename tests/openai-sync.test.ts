import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb, listImports, spendInRange } from "../src/db.js";
import {
  handleSyncOpenai,
  handleListImports,
} from "../src/tools/handlers.js";
import {
  buildCostsUrl,
  costDedupeKey,
  mapCostBuckets,
  mapCostResult,
  resolveAdminKey,
  unixToUtcDate,
  type OpenAICostBucket,
} from "../src/openai/costs.js";

const SAMPLE_BUCKETS: OpenAICostBucket[] = [
  {
    object: "bucket",
    start_time: 1755993600, // 2025-08-24 UTC
    end_time: 1756080000,
    results: [
      {
        object: "organization.costs.result",
        amount: { value: 0.42, currency: "usd" },
        line_item: "gpt-4o, input",
        project_id: "proj_acme",
      },
      {
        object: "organization.costs.result",
        amount: { value: 0.18, currency: "usd" },
        line_item: "gpt-4o, output",
        project_id: "proj_acme",
      },
    ],
  },
  {
    object: "bucket",
    start_time: 1756080000, // 2025-08-25 UTC
    end_time: 1756166400,
    results: [
      {
        object: "organization.costs.result",
        amount: { value: 1.25, currency: "usd" },
        line_item: "Image models",
        project_id: null,
      },
    ],
  },
];

function mockFetchOk(
  pages: Array<{ data: OpenAICostBucket[]; next_page?: string | null }>
): typeof fetch {
  let call = 0;
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    expect(url).toContain("https://api.openai.com/v1/organization/costs");
    const auth = (init?.headers as Record<string, string>)?.Authorization;
    expect(auth).toMatch(/^Bearer /);
    expect(auth).not.toContain("undefined");
    const page = pages[Math.min(call, pages.length - 1)];
    call += 1;
    return {
      ok: true,
      status: 200,
      json: async () => ({
        object: "page",
        data: page.data,
        has_more: Boolean(page.next_page),
        next_page: page.next_page ?? null,
      }),
    } as Response;
  }) as typeof fetch;
}

describe("openai costs mapping", () => {
  it("builds costs URL with defaults and group_by", () => {
    const url = buildCostsUrl({
      startTime: 1700000000,
      limit: 30,
      groupBy: ["line_item", "project_id"],
    });
    expect(url).toContain("https://api.openai.com/v1/organization/costs");
    expect(url).toContain("start_time=1700000000");
    expect(url).toContain("bucket_width=1d");
    expect(url).toContain("limit=30");
    expect(url).toContain("group_by=line_item");
    expect(url).toContain("group_by=project_id");
  });

  it("clamps limit to 1–180", () => {
    expect(buildCostsUrl({ startTime: 1, limit: 999 })).toContain("limit=180");
    expect(buildCostsUrl({ startTime: 1, limit: 0 })).toContain("limit=1");
  });

  it("maps cost results into ledger shape", () => {
    const row = mapCostResult(
      SAMPLE_BUCKETS[0],
      SAMPLE_BUCKETS[0].results![0],
      "client-a"
    );
    expect(row).toMatchObject({
      provider: "openai",
      model: "gpt-4o, input",
      project: "client-a",
      usage_date: "2025-08-24",
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
      cost_usd: 0.42,
      raw_cost_present: true,
    });
    expect(row!.dedupe_key).toBe(
      costDedupeKey("2025-08-24", "gpt-4o, input", "proj_acme", 1755993600)
    );
  });

  it("uses project_id as project when no override", () => {
    const row = mapCostResult(
      SAMPLE_BUCKETS[0],
      SAMPLE_BUCKETS[0].results![0]
    );
    expect(row!.project).toBe("proj_acme");
    expect(row!.dedupe_key).toContain(":proj:proj_acme");
  });

  it("filters by since/until", () => {
    const mapped = mapCostBuckets(SAMPLE_BUCKETS, {
      since: "2025-08-25",
      until: "2025-08-25",
    });
    expect(mapped).toHaveLength(1);
    expect(mapped[0].model).toBe("Image models");
  });

  it("unixToUtcDate is stable UTC", () => {
    expect(unixToUtcDate(1755993600)).toBe("2025-08-24");
  });

  it("resolveAdminKey prefers env then arg", () => {
    expect(
      resolveAdminKey("arg-key", { OPENAI_ADMIN_KEY: " env-key " })
    ).toBe("env-key");
    expect(resolveAdminKey(" arg-key ", {})).toBe("arg-key");
    expect(() => resolveAdminKey(undefined, {})).toThrow(/OPENAI_ADMIN_KEY/);
  });
});

describe("sync_openai handler", () => {
  let dbPath: string;
  let db: ReturnType<typeof openDb>;
  const prevKey = process.env.OPENAI_ADMIN_KEY;

  beforeEach(() => {
    dbPath = path.join(
      os.tmpdir(),
      `llm-ledger-oai-${Date.now()}-${Math.random().toString(16).slice(2)}.db`
    );
    db = openDb(dbPath);
    process.env.OPENAI_ADMIN_KEY = "test-admin-key-not-a-secret";
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
    if (prevKey === undefined) delete process.env.OPENAI_ADMIN_KEY;
    else process.env.OPENAI_ADMIN_KEY = prevKey;
  });

  it("imports cost rows and records an import batch", async () => {
    const result = (await handleSyncOpenai(db, {
      project: "acme",
      fetchImpl: mockFetchOk([{ data: SAMPLE_BUCKETS }]),
    })) as {
      ok: boolean;
      imported: number;
      skipped_duplicates: number;
      import_id: number;
      costs_usd: number;
      api_key?: string;
    };

    expect(result.ok).toBe(true);
    expect(result.imported).toBe(3);
    expect(result.skipped_duplicates).toBe(0);
    expect(result.costs_usd).toBeCloseTo(1.85, 5);
    expect(result.api_key).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain("test-admin-key");

    const spend = spendInRange(db, "2025-08-01", "2025-09-01", "acme");
    expect(spend.rows).toBe(3);
    expect(spend.cost_usd).toBeCloseTo(1.85, 5);

    const imports = listImports(db);
    expect(imports).toHaveLength(1);
    expect(imports[0].provider).toBe("openai");
    expect(imports[0].filename).toContain("openai-costs:");
    expect(imports[0].row_count).toBe(3);

    const listed = handleListImports(db) as { imports: unknown[] };
    expect(listed.imports).toHaveLength(1);
  });

  it("is idempotent — second sync skips duplicates", async () => {
    const fetchImpl = mockFetchOk([{ data: SAMPLE_BUCKETS }]);
    const first = (await handleSyncOpenai(db, {
      fetchImpl,
    })) as { imported: number; skipped_duplicates: number };
    expect(first.imported).toBe(3);

    const second = (await handleSyncOpenai(db, {
      fetchImpl,
    })) as { imported: number; skipped_duplicates: number; mapped: number };
    expect(second.mapped).toBe(3);
    expect(second.imported).toBe(0);
    expect(second.skipped_duplicates).toBe(3);

    const spend = spendInRange(db, "2025-08-01", "2025-09-01");
    expect(spend.rows).toBe(3);
    expect(spend.cost_usd).toBeCloseTo(1.85, 5);
  });

  it("paginates via next_page", async () => {
    const fetchImpl = mockFetchOk([
      {
        data: [SAMPLE_BUCKETS[0]],
        next_page: "cursor-page-2",
      },
      {
        data: [SAMPLE_BUCKETS[1]],
        next_page: null,
      },
    ]);
    const result = (await handleSyncOpenai(db, {
      fetchImpl,
    })) as { fetched_buckets: number; imported: number };
    expect(result.fetched_buckets).toBe(2);
    expect(result.imported).toBe(3);
  });

  it("surfaces 403 admin-key guidance without echoing the key", async () => {
    const fetchImpl = (async () =>
      ({
        ok: false,
        status: 403,
        json: async () => ({
          error: {
            message: "You must be an organization owner to access this endpoint",
            type: "invalid_request_error",
          },
        }),
      }) as Response) as typeof fetch;

    await expect(
      handleSyncOpenai(db, {
        api_key: "sk-inference-looking-key",
        fetchImpl,
      })
    ).rejects.toThrow(/Admin API key/);

    try {
      // Clear env so arg is used; still must not echo.
      delete process.env.OPENAI_ADMIN_KEY;
      await handleSyncOpenai(db, {
        api_key: "sk-inference-looking-key",
        fetchImpl,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      expect(msg).not.toContain("sk-inference-looking-key");
    }
  });

  it("filters with since/until client-side", async () => {
    const result = (await handleSyncOpenai(db, {
      since: "2025-08-25",
      until: "2025-08-25",
      fetchImpl: mockFetchOk([{ data: SAMPLE_BUCKETS }]),
    })) as { imported: number; mapped: number; fetched_buckets: number };
    expect(result.fetched_buckets).toBe(2);
    expect(result.mapped).toBe(1);
    expect(result.imported).toBe(1);
  });
});
