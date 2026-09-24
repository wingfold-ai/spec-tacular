/**
 * Copy and paste in the whole app: ctrl+c copies a mouse selection and is
 * back without one, ctrl+v and the terminal's paste land in the inputs of
 * every screen, and what the clipboard could not do is said in the corner.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { testRender, useKeyboard } from '@opentui/solid';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { answerFoundation, foundationDir, guidedQuestions } from '../src/core/foundation.ts';
import type { ClipboardPort } from '../src/tui/clipboard.ts';
import { ClipboardProvider, useSelectionCopy } from '../src/tui/copy-paste.ts';
import { mountApp } from './support/app-harness.tsx';

const mounted: { destroy: () => void }[] = [];
afterEach(() => {
  for (const m of mounted.splice(0)) m.destroy();
});

const clipboardOf = (text: string): ClipboardPort => ({
  read: async () => ({ ok: true, text }),
  write: async () => ({ ok: true, via: 'fake' }),
});

/** Set up, ground rules settled, on the overview. */
async function overview(options: Parameters<typeof mountApp>[0] = {}) {
  const ui = await mountApp({ baseline: true, ...options });
  mounted.push(ui);
  await ui.press('return'); // Start
  for (const q of guidedQuestions(ui.root)) answerFoundation(q.item, 'Decided.');
  await ui.press('c', { ctrl: true });
  return ui;
}

describe('pasting into the app’s inputs', () => {
  test('ctrl+v fills the new-change description, its lines joined, without sending it', async () => {
    const ui = await overview({ clipboard: clipboardOf('Let users log in\nwith email and password') });
    await ui.press('n');
    await ui.press('v', { ctrl: true });
    expect(ui.frame()).toContain('› Let users log in with email and password▏');
    expect(ui.frame()).toContain('New change · 1 of 2');
    await ui.press('return');
    expect(ui.frame()).toContain('New change · 2 of 2');
  });

  test('a multi-line terminal paste lands whole, and no line of it is an enter', async () => {
    const ui = await overview();
    await ui.press('n');
    await ui.paste('Let users log in\nwith email\n');
    expect(ui.frame()).toContain('› Let users log in with email▏');
    expect(ui.frame()).toContain('New change · 1 of 2');
  });

  test('when the clipboard cannot be read, the corner says why', async () => {
    const ui = await overview();
    await ui.press('n');
    await ui.press('v', { ctrl: true });
    expect(ui.frame()).toContain('no clipboard in this test');
    expect(ui.frame()).toContain('New change · 1 of 2');
  });

  test('ctrl+v answers a ground-rules question', async () => {
    const ui = await mountApp({ baseline: true, clipboard: clipboardOf('Lets clinic staff book rooms') });
    mounted.push(ui);
    await ui.press('return'); // Start
    await ui.press('return'); // Begin
    await ui.press('v', { ctrl: true });
    expect(ui.frame()).toContain('› Lets clinic staff book rooms');
    await ui.press('return');
    expect(readFileSync(join(foundationDir(ui.root), 'domain.md'), 'utf8')).toContain('Lets clinic staff book rooms');
  });
});

describe('ctrl+c: copy over a selection, back without one', () => {
  async function mountSelectable() {
    const clip = { writes: [] as string[], notices: [] as string[] };
    const value = {
      clipboard: {
        read: async () => ({ ok: true as const, text: '' }),
        write: async (text: string) => {
          clip.writes.push(text);
          return { ok: true as const, via: 'fake' };
        },
      },
      notify: (m: string) => clip.notices.push(m),
    };
    let back = 0;
    function Screen() {
      useSelectionCopy();
      useKeyboard((key) => {
        if (key.ctrl && key.name === 'c') back++;
      });
      return (
        <box style={{ flexDirection: 'column' }}>
          <text>Requirement: Session timeout</text>
          <text>The system SHALL end an idle session.</text>
        </box>
      );
    }
    const setup = await testRender(
      () => (
        <ClipboardProvider value={value}>
          <Screen />
        </ClipboardProvider>
      ),
      { width: 60, height: 10, exitOnCtrlC: false },
    );
    mounted.push({ destroy: () => setup.renderer.destroy() });
    await setup.flush();
    const settle = async () => {
      await new Promise((r) => setTimeout(r, 15));
      await setup.flush();
    };
    return { setup, clip, back: () => back, settle };
  }

  test('a dragged selection is copied, and the key goes no further', async () => {
    const { setup, clip, back, settle } = await mountSelectable();
    await setup.mockMouse.drag(0, 0, 10, 0);
    await settle();
    expect(setup.renderer.getSelection()?.getSelectedText()).toBe('Requirement');

    setup.mockInput.pressKey('c', { ctrl: true });
    await settle();
    expect(clip.writes).toEqual(['Requirement']);
    expect(clip.notices).toEqual(['Copied 11 characters']);
    expect(back()).toBe(0);
    expect(setup.renderer.getSelection()).toBeNull();

    // The selection is gone, so the next ctrl+c is back again.
    setup.mockInput.pressKey('c', { ctrl: true });
    await settle();
    expect(back()).toBe(1);
    expect(clip.writes).toHaveLength(1);
  });

  test('without a selection, ctrl+c is back', async () => {
    const { setup, clip, back, settle } = await mountSelectable();
    setup.mockInput.pressKey('c', { ctrl: true });
    await settle();
    expect(back()).toBe(1);
    expect(clip.writes).toEqual([]);
  });

  test('any other key ends a selection, so a later ctrl+c means back', async () => {
    const { setup, clip, back, settle } = await mountSelectable();
    await setup.mockMouse.drag(0, 1, 10, 1);
    await settle();
    setup.mockInput.pressKey('n');
    await settle();
    setup.mockInput.pressKey('c', { ctrl: true });
    await settle();
    expect(clip.writes).toEqual([]);
    expect(back()).toBe(1);
  });
});
