/**
 * The AI usage sidebar: what is answering, what it cost, and what it is doing
 * — mounted on the real App, at a width where it has room to show.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import type { Usage } from '../src/core/usage.ts';
import { freshChange, mountApp } from './support/app-harness.tsx';

const open: { destroy: () => void }[] = [];
afterEach(() => {
  for (const r of open.splice(0)) r.destroy();
});

async function mount() {
  let emit: ((usage: Usage) => void) | null = null;
  const ui = await mountApp({
    width: 200,
    baseline: true,
    changes: [freshChange('add-login')],
    onUsage: (listener) => {
      emit = listener;
      return () => {
        emit = null;
      };
    },
  });
  open.push(ui);
  // Home's first action is "Open project": the overview, where the sidebar shows.
  await ui.press('return');
  return { ...ui, report: (usage: Usage) => emit?.(usage) };
}

describe('AI usage sidebar', () => {
  test('shows the driver, the model and the running cost', async () => {
    const ui = await mount();
    expect(ui.frame()).toContain('Claude Code');
    expect(ui.frame()).toContain('$0.00');

    ui.report({
      driver: 'claude',
      model: 'claude-sonnet-4-5-20250929',
      costUsd: 0.42,
      inputTokens: 1200,
      outputTokens: 340,
    });
    await ui.settle();

    const frame = ui.frame();
    expect(frame).toContain('$0.42');
    expect(frame).toContain('sonnet-4-5');
    expect(frame).toContain('1 request');
  });

  test('ctrl+b expands the per-model breakdown, and closes again', async () => {
    const ui = await mount();
    ui.report({ driver: 'claude', model: 'claude-sonnet-4-5-20250929', costUsd: 0.42 });
    await ui.settle();

    await ui.press('b', { ctrl: true });
    expect(ui.frame()).toContain('By model');
    expect(ui.frame()).toContain('sonnet-4-5');

    await ui.press('b', { ctrl: true });
    expect(ui.frame()).not.toContain('By model');
  });

  test('a running job says what the agent is doing', async () => {
    const ui = await mount();
    await ui.press('w');
    expect(ui.frame()).toContain('is drafting the proposal');
  });
});
