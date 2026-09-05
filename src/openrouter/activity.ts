/**
 * OpenRouter Activity API client + row mapping.
 * Requires a Management API key (provisioning key), not an inference key.
 */

export type OpenRouterActivityItem = {
  date: string;
  model: string;
  model_permaslug?: string;
  endpoint_id: string;
  provider_name?: string;
  usage: number;
  byok_usage_inference?: number;
  requests?: number;
  prompt_tokens: number;
  completion_tokens: number;
  reasoning_tokens?: number;
  workspace_id?: string;
};

export type OpenRouterActivityResponse = {
  data: OpenRouterActivityItem[];
};

export type MappedActivityRow = {
  provider: "openrouter";
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

export type FetchActivityOptions = {
  apiKey: string;
  /** Pass-through single UTC date filter (YYYY-MM-DD). */
  date?: string;
  apiKeyHash?: string;
  userId?: string;
  workspaceId?: string;
  groupByWorkspace?: boolean;
  /** Injectable fetch for tests. */
  fetchImpl?: typeof fetch;
};

const ACTIVITY_URL = "https://openrouter.ai/api/v1/activity";

export function buildActivityUrl(opts: {
  date?: string;
  apiKeyHash?: string;
  userId?: string;
  workspaceId?: string;
  groupByWorkspace?: boolean;
}): string {
  const url = new URL(ACTIVITY_URL);
  if (opts.date) url.searchParams.set("date", opts.date);
  if (opts.apiKeyHash) url.searchParams.set("api_key_hash", opts.apiKeyHash);
  if (opts.userId) url.searchParams.set("user_id", opts.userId);
  if (opts.workspaceId) url.searchParams.set("workspace_id", opts.workspaceId);
  if (opts.groupByWorkspace) url.searchParams.set("group_by", "workspace");
  return url.toString();
}

export async function fetchOpenRouterActivity(
  opts: FetchActivityOptions
): Promise<OpenRouterActivityItem[]> {
  const url = buildActivityUrl({
    date: opts.date,
    apiKeyHash: opts.apiKeyHash,
    userId: opts.userId,
    workspaceId: opts.workspaceId,
    groupByWorkspace: opts.groupByWorkspace,
  });
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
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
        error?: { message?: string; code?: number };
      };
      detail = body?.error?.message ? `: ${body.error.message}` : "";
    } catch {
      /* ignore parse errors */
    }
    if (res.status === 401 || res.status === 403) {
      throw new Error(
        `OpenRouter activity API returned ${res.status}${detail}. ` +
          "Use a Management API key (OPENROUTER_MANAGEMENT_KEY from " +
          "https://openrouter.ai/settings/management-keys). " +
          "Inference / chat API keys return 401/403 on this endpoint."
      );
    }
    throw new Error(`OpenRouter activity API returned ${res.status}${detail}`);
  }

  const json = (await res.json()) as OpenRouterActivityResponse;
  if (!json || !Array.isArray(json.data)) {
    throw new Error("OpenRouter activity API returned unexpected payload");
  }
  return json.data;
}

/** Stable unique key: day + model + endpoint (+ workspace when present). */
export function activityDedupeKey(item: OpenRouterActivityItem): string {
  const ws = item.workspace_id ? `:ws:${item.workspace_id}` : "";
  return `or:activity:${item.date}:${item.model}:${item.endpoint_id}${ws}`;
}

export function mapActivityItem(
  item: OpenRouterActivityItem,
  projectOverride?: string | null
): MappedActivityRow | null {
  const usage_date = (item.date || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(usage_date)) return null;
  const model = (item.model || item.model_permaslug || "unknown").trim();
  if (!model) return null;

  const input_tokens = Number(item.prompt_tokens) || 0;
  const output_tokens = Number(item.completion_tokens) || 0;
  const reasoning = Number(item.reasoning_tokens) || 0;
  const total_tokens = input_tokens + output_tokens + reasoning;
  const cost_usd = Number(item.usage);
  if (!Number.isFinite(cost_usd)) return null;

  const project =
    (projectOverride && projectOverride.trim()) ||
    item.workspace_id ||
    null;

  return {
    provider: "openrouter",
    model,
    project,
    usage_date,
    input_tokens,
    output_tokens,
    total_tokens,
    cost_usd,
    raw_cost_present: true,
    dedupe_key: activityDedupeKey(item),
  };
}

export function mapActivityItems(
  items: OpenRouterActivityItem[],
  opts?: {
    project?: string | null;
    since?: string;
    until?: string;
  }
): MappedActivityRow[] {
  const since = opts?.since;
  const until = opts?.until;
  const out: MappedActivityRow[] = [];
  for (const item of items) {
    if (since && item.date < since) continue;
    if (until && item.date > until) continue;
    const mapped = mapActivityItem(item, opts?.project);
    if (mapped) out.push(mapped);
  }
  return out;
}

export function resolveManagementKey(
  apiKeyArg?: string | null,
  env: NodeJS.ProcessEnv = process.env
): string {
  const fromArg = apiKeyArg?.trim();
  if (fromArg) return fromArg;
  const fromEnv = env.OPENROUTER_MANAGEMENT_KEY?.trim();
  if (fromEnv) return fromEnv;
  throw new Error(
    "Missing OpenRouter Management API key. Set env OPENROUTER_MANAGEMENT_KEY " +
      "or pass api_key. Create a key at https://openrouter.ai/settings/management-keys " +
      "(inference keys cannot call /activity)."
  );
}
