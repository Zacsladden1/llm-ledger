/**
 * OpenAI Organization Costs API client + row mapping.
 * Requires an Admin API key (not a regular sk- inference key).
 * Docs: GET https://api.openai.com/v1/organization/costs
 */

export type OpenAICostResult = {
  object?: string;
  amount?: { value?: number; currency?: string };
  line_item?: string | null;
  project_id?: string | null;
  organization_id?: string | null;
};

export type OpenAICostBucket = {
  object?: string;
  start_time: number;
  end_time?: number;
  results?: OpenAICostResult[];
};

export type OpenAICostsResponse = {
  object?: string;
  data?: OpenAICostBucket[];
  has_more?: boolean;
  next_page?: string | null;
};

export type MappedCostRow = {
  provider: "openai";
  model: string;
  project: string | null;
  usage_date: string;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cost_usd: number;
  raw_cost_present: boolean;
  dedupe_key: string;
};

export type FetchCostsOptions = {
  apiKey: string;
  /** Unix seconds inclusive start; default ~30 days ago. */
  startTime?: number;
  /** Unix seconds exclusive end. */
  endTime?: number;
  bucketWidth?: "1d";
  /** Buckets to return (1–180); default 30. */
  limit?: number;
  /** Prefer line_item / project_id for usable labels. */
  groupBy?: Array<"line_item" | "project_id" | "api_key_id">;
  projectIds?: string[];
  /** Injectable fetch for tests. */
  fetchImpl?: typeof fetch;
};

const COSTS_URL = "https://api.openai.com/v1/organization/costs";

export function defaultStartTime(nowSec = Math.floor(Date.now() / 1000)): number {
  return nowSec - 30 * 24 * 60 * 60;
}

export function buildCostsUrl(opts: {
  startTime: number;
  endTime?: number;
  bucketWidth?: "1d";
  limit?: number;
  groupBy?: Array<"line_item" | "project_id" | "api_key_id">;
  projectIds?: string[];
  page?: string;
}): string {
  const url = new URL(COSTS_URL);
  url.searchParams.set("start_time", String(opts.startTime));
  if (opts.endTime !== undefined) {
    url.searchParams.set("end_time", String(opts.endTime));
  }
  url.searchParams.set("bucket_width", opts.bucketWidth ?? "1d");
  const limit = Math.min(180, Math.max(1, opts.limit ?? 30));
  url.searchParams.set("limit", String(limit));
  const groupBy = opts.groupBy ?? ["line_item", "project_id"];
  for (const g of groupBy) {
    url.searchParams.append("group_by", g);
  }
  if (opts.projectIds) {
    for (const id of opts.projectIds) {
      url.searchParams.append("project_ids", id);
    }
  }
  if (opts.page) url.searchParams.set("page", opts.page);
  return url.toString();
}

export async function fetchOpenAICosts(
  opts: FetchCostsOptions
): Promise<OpenAICostBucket[]> {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const startTime = opts.startTime ?? defaultStartTime();
  const limit = opts.limit ?? 30;
  const groupBy = opts.groupBy ?? ["line_item", "project_id"];

  const all: OpenAICostBucket[] = [];
  let page: string | undefined;
  let pages = 0;
  const maxPages = 50;

  while (pages < maxPages) {
    const url = buildCostsUrl({
      startTime,
      endTime: opts.endTime,
      bucketWidth: opts.bucketWidth ?? "1d",
      limit,
      groupBy,
      projectIds: opts.projectIds,
      page,
    });

    const res = await fetchImpl(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${opts.apiKey}`,
        Accept: "application/json",
      },
    });

    if (!res.ok) {
      let detail = "";
      try {
        const body = (await res.json()) as {
          error?: { message?: string; type?: string };
        };
        detail = body?.error?.message ? `: ${body.error.message}` : "";
      } catch {
        /* ignore parse errors */
      }
      if (res.status === 401 || res.status === 403) {
        throw new Error(
          `OpenAI costs API returned ${res.status}${detail}. ` +
            "Use an Organization Admin API key (OPENAI_ADMIN_KEY from " +
            "https://platform.openai.com/settings/organization/admin-keys). " +
            "Regular sk- inference keys cannot call /organization/costs."
        );
      }
      throw new Error(`OpenAI costs API returned ${res.status}${detail}`);
    }

    const json = (await res.json()) as OpenAICostsResponse;
    if (!json || !Array.isArray(json.data)) {
      throw new Error("OpenAI costs API returned unexpected payload");
    }
    all.push(...json.data);
    pages += 1;

    const next = json.next_page;
    if (!next) break;
    page = next;
  }

  return all;
}

/** YYYY-MM-DD (UTC) from unix seconds. */
export function unixToUtcDate(unixSec: number): string {
  return new Date(unixSec * 1000).toISOString().slice(0, 10);
}

/** Stable unique key: day + line_item|project|bucket. */
export function costDedupeKey(
  usageDate: string,
  lineItem: string | null | undefined,
  projectId: string | null | undefined,
  bucketStart: number
): string {
  const label =
    (lineItem && lineItem.trim()) ||
    (projectId && projectId.trim()) ||
    `bucket:${bucketStart}`;
  const proj = projectId && projectId.trim() ? `:proj:${projectId.trim()}` : "";
  // When label already is line_item, still include project for uniqueness.
  if (lineItem && lineItem.trim()) {
    return `oai:costs:${usageDate}:${lineItem.trim()}${proj}`;
  }
  return `oai:costs:${usageDate}:${label}`;
}

export function mapCostResult(
  bucket: OpenAICostBucket,
  result: OpenAICostResult,
  projectOverride?: string | null
): MappedCostRow | null {
  if (typeof bucket.start_time !== "number" || !Number.isFinite(bucket.start_time)) {
    return null;
  }
  const usage_date = unixToUtcDate(bucket.start_time);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(usage_date)) return null;

  const cost_usd = Number(result.amount?.value);
  if (!Number.isFinite(cost_usd)) return null;

  const lineItem = result.line_item?.trim() || null;
  const projectId = result.project_id?.trim() || null;
  const model = lineItem || projectId || "openai-costs";
  const project =
    (projectOverride && projectOverride.trim()) || projectId || null;

  return {
    provider: "openai",
    model,
    project,
    usage_date,
    input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
    cost_usd,
    raw_cost_present: true,
    dedupe_key: costDedupeKey(
      usage_date,
      lineItem,
      projectId,
      bucket.start_time
    ),
  };
}

export function mapCostBuckets(
  buckets: OpenAICostBucket[],
  opts?: {
    project?: string | null;
    since?: string;
    until?: string;
  }
): MappedCostRow[] {
  const since = opts?.since;
  const until = opts?.until;
  const out: MappedCostRow[] = [];
  for (const bucket of buckets) {
    const date = unixToUtcDate(bucket.start_time);
    if (since && date < since) continue;
    if (until && date > until) continue;
    for (const result of bucket.results ?? []) {
      const mapped = mapCostResult(bucket, result, opts?.project);
      if (mapped) out.push(mapped);
    }
  }
  return out;
}

export function resolveAdminKey(
  apiKeyArg?: string | null,
  env: NodeJS.ProcessEnv = process.env
): string {
  const fromEnv = env.OPENAI_ADMIN_KEY?.trim();
  if (fromEnv) return fromEnv;
  const fromArg = apiKeyArg?.trim();
  if (fromArg) return fromArg;
  throw new Error(
    "Missing OpenAI Admin API key. Set env OPENAI_ADMIN_KEY " +
      "or pass api_key. Create a key at " +
      "https://platform.openai.com/settings/organization/admin-keys " +
      "(regular sk- keys cannot call /organization/costs)."
  );
}
