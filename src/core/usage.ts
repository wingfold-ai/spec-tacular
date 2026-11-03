/**
 * What an agent request cost, and what to show for it.
 *
 * Claude reports actual USD and the model it used; opencode reports its own
 * cost and token counts. Both are captured per request and summed, so the
 * sidebar can say what the AI is, what it is doing, and what it has cost
 * without any price table of our own.
 */

import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

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

// ---------------------------------------------------------------------------
// Kept across runs

/** What the TUI's own sessions cost, one request per line: a restart keeps the total. */
export function usageLogPath(projectRoot: string): string {
  return join(projectRoot, '.spec-tacular', 'usage.jsonl');
}

export function appendUsageLog(projectRoot: string, usage: Usage): void {
  try {
    mkdirSync(dirname(usageLogPath(projectRoot)), { recursive: true });
    appendFileSync(usageLogPath(projectRoot), `${JSON.stringify({ at: new Date().toISOString(), ...usage })}\n`, 'utf8');
  } catch {
    // A total that does not survive a restart is not worth failing a request over.
  }
}

export function loadUsageLog(projectRoot: string): Usage[] {
  try {
    return readFileSync(usageLogPath(projectRoot), 'utf8')
      .split('\n')
      .filter((l) => l.trim() !== '')
      .flatMap((l) => {
        try {
          return [JSON.parse(l) as Usage];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// The implementing session

/**
 * Where Claude Code keeps a session's transcript: under the project's path,
 * every character other than a letter or digit a dash.
 */
export function claudeTranscriptPath(cwd: string, sessionId: string, home = homedir()): string {
  return join(home, '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${sessionId}.jsonl`);
}

/**
 * The tokens an interactive Claude Code session used, from its transcript.
 * Interactive sessions report no cost, and spec-tacular keeps no price
 * table: the usage carries tokens and the model, never a guessed cost.
 * Null when there is no transcript (yet).
 */
export function claudeSessionUsage(transcript: string): Usage | null {
  let text: string;
  try {
    text = readFileSync(transcript, 'utf8');
  } catch {
    return null;
  }
  // One assistant message is logged once per content block: count it once.
  const seen = new Set<string>();
  const usage: Usage = { driver: 'claude', inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, turns: 0 };
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let entry: { type?: string; message?: { id?: string; model?: string; usage?: Record<string, number> } };
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const m = entry.message;
    if (entry.type !== 'assistant' || !m?.usage) continue;
    if (m.id) {
      if (seen.has(m.id)) continue;
      seen.add(m.id);
    }
    usage.inputTokens! += m.usage['input_tokens'] ?? 0;
    usage.outputTokens! += m.usage['output_tokens'] ?? 0;
    usage.cacheReadTokens! += m.usage['cache_read_input_tokens'] ?? 0;
    usage.cacheWriteTokens! += m.usage['cache_creation_input_tokens'] ?? 0;
    usage.turns! += 1;
    if (m.model && !m.model.startsWith('<')) usage.model = m.model;
  }
  return usage.turns ? usage : null;
}
