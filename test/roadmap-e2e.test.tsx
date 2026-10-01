/**
 * After planning: implementing in the agent itself, and planning the next
 * slice while the one before it is implemented.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { saveRoadmap } from '../src/core/roadmap.ts';
import { changeWith, freshChange, mountApp } from './support/app-harness.tsx';

const mounted: { destroy: () => void }[] = [];
afterEach(() => {
  for (const m of mounted.splice(0)) m.destroy();
});

const ALL = ['proposal', 'specs', 'design', 'tasks'];
/** A change planned through its tasks, every artifact accepted. */
const planned = (name: string) => changeWith(name, ALL, ALL);

describe('implementing', () => {
  test('opens the agent in this terminal, and comes back when it exits', async () => {
    const asked: string[] = [];
    let root = '';
    const ui = await mountApp({
      baseline: true,
      changes: [planned('book-rooms')],
      implement: async (change) => {
        asked.push(change);
        return { ok: true, label: 'Claude Code', command: { command: 'sh', args: ['-c', 'touch implemented'] } };
      },
    });
    mounted.push(ui);
    root = ui.root;
    await ui.press('return'); // Open project

    expect(ui.frame()).toContain('Planning is done. Implement it — the agent opens right here');
    expect(ui.frame()).toContain('▶ Implement it in Claude Code');
    await ui.press('w');
    await ui.settle(100);

    expect(asked).toEqual(['book-rooms']);
    expect(existsSync(join(root, 'implemented'))).toBe(true); // it ran, in the project
    expect(ui.dispatched).toEqual([]); // not as a background job
    expect(ui.frame()).toContain('Back from Claude Code.');
  });

  test('opens in another tab, and this one stays open and follows it', async () => {
    const launched: string[] = [];
    let running: string[] = [];
    const ui = await mountApp({
      baseline: true,
      changes: [planned('book-rooms')],
      implement: async () => ({ ok: true, label: 'Claude Code', command: { command: 'claude', args: ['apply it'] } }),
      launch: (change, command) => {
        launched.push(`${change}: ${command.command} ${command.args.join(' ')}`);
        running = [change];
        return { ok: true, where: 'a new GNOME Terminal tab' };
      },
      implementing: () => running,
    });
    mounted.push(ui);
    await ui.press('return'); // Open project
    await ui.press('w');
    await ui.settle(50);

    expect(launched).toEqual(['book-rooms: claude apply it']);
    expect(ui.frame()).toContain('Claude Code is implementing book-rooms in a new GNOME Terminal tab.');
    expect(ui.frame()).toContain('◉ Being implemented in another tab');
    // Not twice at once.
    await ui.press('w');
    expect(launched).toHaveLength(1);
    expect(ui.frame()).toContain('book-rooms is already being implemented in another tab');

    // The session ends: said so, from the tasks as they are now.
    running = [];
    await ui.settle(4300);
    expect(ui.frame()).toContain('The session implementing book-rooms ended.');
    expect(ui.frame()).not.toContain('◉ Being implemented in another tab');
  });

  test('a refusal is said, and nothing opens', async () => {
    const ui = await mountApp({
      baseline: true,
      changes: [planned('book-rooms')],
      implement: async () => ({ ok: false, reason: 'Not yet: auth is not applied yet' }),
    });
    mounted.push(ui);
    await ui.press('return'); // Open project
    await ui.press('w');
    await ui.settle(50);
    expect(ui.frame()).toContain('Not yet: auth is not applied yet');
  });
});

const ROADMAP = (root: string) => saveRoadmap(root, {
  vision: 'Room booking for clinics.',
  slices: [
    { id: 'book-rooms', summary: 'Book a room', status: 'active', dependsOn: [] },
    { id: 'see-the-week', summary: 'See the week', status: 'planned', dependsOn: ['book-rooms'] },
  ],
});

describe('the next slice', () => {
  const mountWith = async (current: ReturnType<typeof changeWith>, started: string[]) => {
    const ui = await mountApp({
      baseline: true,
      changes: [current],
      prepare: ROADMAP,
      startNextSlice: async () => {
        started.push('see-the-week');
        ui.changes.push(freshChange('see-the-week'));
        return { ok: true, change: 'see-the-week' };
      },
    });
    mounted.push(ui);
    await ui.press('return'); // Open project
    return ui;
  };

  test('waits while the current slice is still being specified', async () => {
    const started: string[] = [];
    const ui = await mountWith(changeWith('book-rooms', ['proposal'], []), started);
    expect(ui.frame()).not.toContain('next slice');
    await ui.press('s');
    expect(started).toEqual([]);
  });

  test('can be specified once the current one is — before it is designed, let alone applied', async () => {
    const started: string[] = [];
    const ui = await mountWith(changeWith('book-rooms', ['proposal', 'specs'], ['proposal', 'specs']), started);
    expect(ui.frame()).toContain('s  specify the next slice on the roadmap: see-the-week');
    await ui.press('s');
    await ui.settle(50);
    expect(started).toEqual(['see-the-week']);
    expect(ui.frame()).toContain('Started see-the-week: specify it now — its design waits until the slices before it are applied.');
  });
});
