/**
 * What an agent request cost, and what to show for it.
 *
 * Claude reports actual USD and the model it used; opencode reports its own
 * cost and token counts. Both are captured per request and summed, so the
 * sidebar can say what the AI is, what it is doing, and what it has cost
 * without any price table of our own.
 */

export interface Usage {
  /** The driver id: `claude` or `opencode`. */
  driver: string;
  /** The model the agent actually used, when it says so. */
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  /** Actual cost in USD, as the agent reports it. */
  costUsd?: number;
  durationMs?: number;
  turns?: number;
}

/** One model's share of the total. */
export interface ModelUsage {
  driver: string;
  model: string;
  costUsd: number;
  requests: number;
}

export interface UsageTotals {
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  requests: number;
  /** Models seen so far, in first-seen order. */
  models: ModelUsage[];
}

export function emptyUsage(): UsageTotals {
  return {
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    requests: 0,
    models: [],
  };
}

/** Adds one request's usage, returning a new total (safe for a signal). */
export function addUsage(totals: UsageTotals, usage: Usage): UsageTotals {
  const models = totals.models.map((m) => ({ ...m }));
  if (usage.model) {
    const i = models.findIndex((m) => m.driver === usage.driver && m.model === usage.model);
    if (i >= 0) {
      models[i]!.costUsd += usage.costUsd ?? 0;
      models[i]!.requests += 1;
    } else {
      models.push({
        driver: usage.driver,
        model: usage.model,
        costUsd: usage.costUsd ?? 0,
        requests: 1,
      });
    }
  }
  return {
    costUsd: totals.costUsd + (usage.costUsd ?? 0),
    inputTokens: totals.inputTokens + (usage.inputTokens ?? 0),
    outputTokens: totals.outputTokens + (usage.outputTokens ?? 0),
    cacheReadTokens: totals.cacheReadTokens + (usage.cacheReadTokens ?? 0),
    cacheWriteTokens: totals.cacheWriteTokens + (usage.cacheWriteTokens ?? 0),
    requests: totals.requests + 1,
    models,
  };
}

export function sumUsage(usages: Usage[]): UsageTotals {
  return usages.reduce(addUsage, emptyUsage());
}

/**
 * Every input token the model read. `inputTokens` alone is only the part that
 * missed the cache — with sessions that resend their context, a few tokens
 * per turn while thousands are read from or written to the cache.
 */
export function totalInput(totals: UsageTotals): number {
  return totals.inputTokens + totals.cacheReadTokens + totals.cacheWriteTokens;
}

/** `$0.42`, `<$0.01` for a fraction of a cent, `$0.00` for nothing. */
export function formatCost(usd: number | undefined): string {
  if (usd === undefined || usd <= 0) return '$0.00';
  if (usd < 0.01) return '<$0.01';
  return `$${usd.toFixed(2)}`;
}

/** `12345` → `12.3k`, `1200000` → `1.2M`. */
export function formatTokens(n: number | undefined): string {
  if (n === undefined) return '0';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/**
 * `claude-sonnet-4-5-20250929` → `sonnet-4-5`; an id that does not look like
 * a dated Claude model is left as it is.
 */
export function shortModel(model: string | undefined): string | undefined {
  if (!model) return undefined;
  const dated = /^claude-(.+?)-\d{8}$/.exec(model);
  return dated ? dated[1] : model;
}

/** How a driver is named on screen. */
export function driverLabel(driver: string): string {
  return driver === 'claude' ? 'Claude Code' : driver === 'opencode' ? 'opencode' : driver;
}
