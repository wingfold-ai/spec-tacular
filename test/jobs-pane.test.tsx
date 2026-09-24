import { afterEach, describe, expect, test } from 'bun:test';
import { testRender } from '@opentui/solid';
import { createSignal } from 'solid-js';
import { JobPane, summarizeJobs } from '../src/tui/jobs.tsx';
import type { Job } from '../src/core/jobs.ts';

const job = (over: Partial<Job> = {}): Job => ({
  id: 'j1', change: 'add-dark-mode', artifact: 'design', driver: 'claude',
  command: 'claude', args: [], cwd: '/p', status: 'running',
  startedAt: '2026-09-21T10:00:00.000Z', logPath: '/p/.spec-tacular/jobs/j1.log',
  ...over,
});

const open: { destroy: () => void }[] = [];
afterEach(() => {
  for (const r of open.splice(0)) r.destroy();
});

async function mount(jobs: Job[], lines: string[] = []) {
  const [selected, setSelected] = createSignal(0);
  const cancelled: Job[] = [];
  let closed = false;

  const setup = await testRender(
    () => (
      <JobPane
        jobs={jobs}
        lines={lines}
        selected={selected()}
        onSelect={setSelected}
        onCancel={(j) => cancelled.push(j)}
        onClose={() => { closed = true; }}
      />
    ),
    { width: 100, height: 24 },
  );
  await setup.flush();
  open.push({ destroy: () => setup.renderer.destroy() });

  return {
    frame: () => setup.captureCharFrame(),
    press: async (...keys: string[]) => {
      for (const k of keys) await setup.mockInput.pressKey(k);
      await setup.flush();
    },
    selected,
    cancelled,
    wasClosed: () => closed,
  };
}

describe('summarizeJobs', () => {
  test('puts running first — it is the only status anyone waits on', () => {
    expect(
      summarizeJobs([job(), job({ status: 'succeeded' }), job({ status: 'failed' })]),
    ).toBe('1 running · 1 failed · 1 succeeded');
  });

  test('is empty when there are no jobs', () => {
    expect(summarizeJobs([])).toBe('');
  });
});

describe('job pane', () => {
  test('lists jobs with their status and shows the selected one’s output', async () => {
    const ui = await mount([job(), job({ id: 'j2', change: 'other', status: 'succeeded' })], [
      'Writing design.md',
      '· Write',
    ]);
    const frame = ui.frame();
    expect(frame).toContain('add-dark-mode/design');
    expect(frame).toContain('other/design');
    expect(frame).toContain('Writing design.md');
    expect(frame).toContain('1 running · 1 succeeded');
  });

  test('j/k move the selection', async () => {
    const ui = await mount([job(), job({ id: 'j2' })]);
    await ui.press('j');
    expect(ui.selected()).toBe(1);
    await ui.press('k');
    expect(ui.selected()).toBe(0);
  });

  test('cancelling asks first, because it throws away work in progress', async () => {
    const ui = await mount([job()]);
    await ui.press('x');
    expect(ui.frame()).toContain('Its work in progress is lost');
    expect(ui.cancelled).toEqual([]);

    await ui.press('y');
    expect(ui.cancelled.map((j) => j.id)).toEqual(['j1']);
  });

  test('any key other than y declines the cancel', async () => {
    const ui = await mount([job()]);
    await ui.press('x');
    await ui.press('n');
    expect(ui.cancelled).toEqual([]);
    expect(ui.frame()).not.toContain('work in progress is lost');
  });

  test('a job that is not running cannot be cancelled', async () => {
    const ui = await mount([job({ status: 'succeeded' })]);
    await ui.press('x');
    expect(ui.frame()).not.toContain('work in progress is lost');
  });

  test('q closes the pane', async () => {
    const ui = await mount([job()]);
    await ui.press('q');
    expect(ui.wasClosed()).toBe(true);
  });

  test('says how to start one when there are none', async () => {
    expect((await mount([])).frame()).toContain('spectacular run');
  });

  test('a job with no output yet says so rather than rendering blank', async () => {
    expect((await mount([job()], [])).frame()).toContain('no output yet');
  });

  test('an interrupted job is distinguishable from a failed one', async () => {
    const ui = await mount([job({ status: 'interrupted' }), job({ id: 'j2', status: 'failed' })]);
    expect(ui.frame()).toContain('interrupted');
    expect(ui.frame()).toContain('failed');
  });
});
