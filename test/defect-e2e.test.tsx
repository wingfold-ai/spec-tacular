/**
 * Reporting a defect from the overview: `b` opens the same two-step prompt
 * as a new change, asking what went wrong, and creates a defect change.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { answerFoundation, guidedQuestions } from '../src/core/foundation.ts';
import { mountApp } from './support/app-harness.tsx';

const mounted: { destroy: () => void }[] = [];
afterEach(() => {
  for (const m of mounted.splice(0)) m.destroy();
});

async function overview() {
  const ui = await mountApp({ baseline: true });
  mounted.push(ui);
  await ui.press('return'); // Start
  for (const q of guidedQuestions(ui.root)) answerFoundation(q.item, 'Decided.');
  await ui.press('c', { ctrl: true });
  return ui;
}

describe('reporting a defect', () => {
  test('b asks what went wrong, then a name, and creates a defect change', async () => {
    const ui = await overview();
    await ui.press('b');
    expect(ui.frame()).toContain('Defect · 1 of 2 · what');
    expect(ui.frame()).toContain('What went wrong?');
    await ui.paste('Export includes other users rows');
    await ui.press('return');
    expect(ui.frame()).toContain('Defect · 2 of 2 · name');
    await ui.press('return');
    expect(ui.created.at(-1)).toMatchObject({ description: 'Export includes other users rows', kind: 'defect' });
  });

  test('n still creates an ordinary change', async () => {
    const ui = await overview();
    await ui.press('n');
    expect(ui.frame()).toContain('New change · 1 of 2 · what');
    await ui.paste('Let users log in');
    await ui.press('return');
    await ui.press('return');
    expect(ui.created.at(-1)).toMatchObject({ kind: 'change' });
  });
});
