import { describe, expect, test } from 'bun:test';
import {
  addUsage,
  driverLabel,
  emptyUsage,
  formatCost,
  formatTokens,
  shortModel,
  sumUsage,
} from '../src/core/usage.ts';

describe('usage totals', () => {
  test('sums cost, tokens and requests, and keeps a per-model breakdown', () => {
    const totals = sumUsage([
      { driver: 'claude', model: 'claude-sonnet-4-5-20250929', costUsd: 0.1, inputTokens: 100, outputTokens: 10 },
      { driver: 'claude', model: 'claude-sonnet-4-5-20250929', costUsd: 0.2, inputTokens: 50, outputTokens: 5 },
      { driver: 'opencode', model: 'openrouter/anthropic/claude-sonnet-4', costUsd: 0.0028, inputTokens: 9000, outputTokens: 3 },
    ]);
    expect(totals.costUsd).toBeCloseTo(0.3028, 6);
    expect(totals.requests).toBe(3);
    expect(totals.inputTokens).toBe(9150);
    expect(totals.outputTokens).toBe(18);
    expect(totals.models).toHaveLength(2);
    expect(totals.models[0]!.driver).toBe('claude');
    expect(totals.models[0]!.model).toBe('claude-sonnet-4-5-20250929');
    expect(totals.models[0]!.costUsd).toBeCloseTo(0.3, 6);
    expect(totals.models[0]!.requests).toBe(2);
    expect(totals.models[1]!.model).toBe('openrouter/anthropic/claude-sonnet-4');
    expect(totals.models[1]!.requests).toBe(1);
  });

  test('a request with no model still counts, without inventing a model row', () => {
    const totals = addUsage(emptyUsage(), { driver: 'claude', costUsd: 0.01 });
    expect(totals.requests).toBe(1);
    expect(totals.costUsd).toBe(0.01);
    expect(totals.models).toEqual([]);
  });

  test('does not mutate the totals it is given', () => {
    const before = emptyUsage();
    addUsage(before, { driver: 'claude', model: 'm', costUsd: 1 });
    expect(before.requests).toBe(0);
    expect(before.models).toEqual([]);
  });
});

describe('formatting', () => {
  test('cost rounds to cents, marks a fraction of a cent, and shows nothing as $0.00', () => {
    expect(formatCost(0)).toBe('$0.00');
    expect(formatCost(undefined)).toBe('$0.00');
    expect(formatCost(0.004)).toBe('<$0.01');
    expect(formatCost(0.0174)).toBe('$0.02');
    expect(formatCost(1.239)).toBe('$1.24');
  });

  test('tokens are shortened', () => {
    expect(formatTokens(999)).toBe('999');
    expect(formatTokens(12345)).toBe('12.3k');
    expect(formatTokens(1_200_000)).toBe('1.2M');
    expect(formatTokens(undefined)).toBe('0');
  });

  test('a dated Claude model id loses its prefix and date', () => {
    expect(shortModel('claude-sonnet-4-5-20250929')).toBe('sonnet-4-5');
    expect(shortModel('openrouter/anthropic/claude-sonnet-4')).toBe('openrouter/anthropic/claude-sonnet-4');
    expect(shortModel(undefined)).toBeUndefined();
  });

  test('drivers are named for people', () => {
    expect(driverLabel('claude')).toBe('Claude Code');
    expect(driverLabel('opencode')).toBe('opencode');
  });
});
