/**
 * The system clipboard (src/tui/clipboard.ts) on every platform it knows,
 * through a recording runner — no test here touches a real clipboard — and
 * the small decisions copy and paste rest on (src/tui/copy-paste.ts).
 */
import { describe, expect, test } from 'bun:test';
import {
  cleanPaste,
  isRemote,
  osc52,
  readCommands,
  SystemClipboard,
  writeCommands,
  type ClipboardEnvironment,
  type Runner,
} from '../src/tui/clipboard.ts';
import { isPasteKey, selectedText, selectionAction } from '../src/tui/copy-paste.ts';
import { isNewline } from '../src/tui/revise.tsx';

const WAYLAND: NodeJS.ProcessEnv = { WAYLAND_DISPLAY: 'wayland-0', DISPLAY: ':0' };
const X11: NodeJS.ProcessEnv = { DISPLAY: ':0' };

const where = (platform: NodeJS.Platform, env: NodeJS.ProcessEnv, installed: string[]): ClipboardEnvironment => ({
  platform,
  env,
  has: (c) => installed.includes(c),
});

/** Answers from a table, and remembers what was run with what input. */
function recorder(answers: Record<string, { code: number | null; stdout?: string }> = {}) {
  const calls: { command: string; args: string[]; input?: string; capture: boolean }[] = [];
  const runner: Runner = async (command, args, options) => {
    calls.push({ command, args, input: options.input, capture: options.capture });
    const a = answers[command] ?? { code: 0 };
    return { code: a.code, stdout: a.stdout ?? '' };
  };
  return { runner, calls };
}

describe('which tool', () => {
  test('Wayland first, even with XWayland about', () => {
    const w = where('linux', WAYLAND, ['wl-copy', 'wl-paste', 'xclip']);
    expect(readCommands(w)[0]).toEqual(['wl-paste', ['--no-newline']]);
    expect(writeCommands(w)[0]).toEqual(['wl-copy', []]);
  });

  test('X11: xclip, then xsel', () => {
    const w = where('linux', X11, ['xclip', 'xsel']);
    expect(readCommands(w)).toEqual([
      ['xclip', ['-selection', 'clipboard', '-o']],
      ['xsel', ['--clipboard', '--output']],
    ]);
    expect(writeCommands(w).map(([c]) => c)).toEqual(['xclip', 'xsel']);
  });

  test('macOS: pbpaste and pbcopy', () => {
    const w = where('darwin', {}, ['pbcopy', 'pbpaste']);
    expect(readCommands(w)).toEqual([['pbpaste', []]]);
    expect(writeCommands(w)).toEqual([['pbcopy', []]]);
  });

  test('only what is installed', () => {
    expect(readCommands(where('linux', WAYLAND, []))).toEqual([]);
    expect(writeCommands(where('linux', X11, ['xsel'])).map(([c]) => c)).toEqual(['xsel']);
  });
});

describe('reading', () => {
  test('returns what the tool printed', async () => {
    const { runner, calls } = recorder({ 'wl-paste': { code: 0, stdout: 'line one\nline two' } });
    const clip = new SystemClipboard({ runner, where: where('linux', WAYLAND, ['wl-paste']) });
    expect(await clip.read()).toEqual({ ok: true, text: 'line one\nline two' });
    expect(calls).toEqual([{ command: 'wl-paste', args: ['--no-newline'], input: undefined, capture: true }]);
  });

  test('falls through to the next tool when one fails', async () => {
    const { runner, calls } = recorder({ xclip: { code: 1 }, xsel: { code: 0, stdout: 'from xsel' } });
    const clip = new SystemClipboard({ runner, where: where('linux', X11, ['xclip', 'xsel']) });
    expect(await clip.read()).toEqual({ ok: true, text: 'from xsel' });
    expect(calls.map((c) => c.command)).toEqual(['xclip', 'xsel']);
  });

  test('with no tool, says what to do instead', async () => {
    const { runner, calls } = recorder();
    const clip = new SystemClipboard({ runner, where: where('linux', {}, []) });
    const result = await clip.read();
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toContain('ctrl+shift+v');
    expect(calls).toEqual([]);
  });
});

describe('writing', () => {
  test('pipes the text to the tool, without waiting on its output', async () => {
    const { runner, calls } = recorder();
    const clip = new SystemClipboard({ runner, where: where('darwin', {}, ['pbcopy']), osc52: () => true });
    expect(await clip.write('copied text')).toEqual({ ok: true, via: 'pbcopy' });
    expect(calls).toEqual([{ command: 'pbcopy', args: [], input: 'copied text', capture: false }]);
  });

  test('falls back to OSC 52 when no tool is installed, or the tool fails', async () => {
    const sent: string[] = [];
    const none = new SystemClipboard({ runner: recorder().runner, where: where('linux', X11, []), osc52: (t) => (sent.push(t), true) });
    expect(await none.write('a')).toEqual({ ok: true, via: 'terminal' });

    const failing = recorder({ 'wl-copy': { code: 1 } });
    const broken = new SystemClipboard({ runner: failing.runner, where: where('linux', WAYLAND, ['wl-copy']), osc52: (t) => (sent.push(t), true) });
    expect(await broken.write('b')).toEqual({ ok: true, via: 'terminal' });
    expect(sent).toEqual(['a', 'b']);
  });

  test('over SSH, goes straight to the terminal: the remote clipboard is nobody’s', async () => {
    const { runner, calls } = recorder();
    const sent: string[] = [];
    const clip = new SystemClipboard({
      runner,
      where: where('linux', { ...X11, SSH_CONNECTION: '1.2.3.4 22 5.6.7.8 22' }, ['xclip']),
      osc52: (t) => (sent.push(t), true),
    });
    expect(await clip.write('remote')).toEqual({ ok: true, via: 'terminal' });
    expect(calls).toEqual([]);
    expect(sent).toEqual(['remote']);
  });

  test('says so when nothing can take it', async () => {
    const clip = new SystemClipboard({ runner: recorder().runner, where: where('linux', {}, []), osc52: () => false });
    const result = await clip.write('x');
    expect(result.ok).toBe(false);
  });

  test('OSC 52 carries the text in base64, wrapped for tmux', () => {
    expect(osc52('héllo', {})).toBe(`\x1b]52;c;${Buffer.from('héllo').toString('base64')}\x07`);
    const tmux = osc52('x', { TMUX: '/tmp/tmux' });
    expect(tmux.startsWith('\x1bPtmux;\x1b\x1b]52;c;')).toBe(true);
    expect(tmux.endsWith('\x1b\\')).toBe(true);
    expect(isRemote({ SSH_TTY: '/dev/pts/1' })).toBe(true);
    expect(isRemote({})).toBe(false);
  });
});

describe('pasted text', () => {
  test('keeps its lines in a multi-line input, joins them in a one-line one', () => {
    const pasted = 'first line\r\nsecond\tline\r\n\r\nthird\x1b[31m!\x1b[0m\x07';
    expect(cleanPaste(pasted, true)).toBe('first line\nsecond  line\n\nthird!');
    expect(cleanPaste(pasted, false)).toBe('first line second  line third!');
  });
});

describe('keys', () => {
  test('ctrl+c copies only over selected text', () => {
    const ctrlC = { ctrl: true, name: 'c', meta: false };
    expect(selectionAction(ctrlC, 'Requirement: Session timeout')).toBe('copy');
    expect(selectionAction(ctrlC, '')).toBe('pass');
    expect(selectionAction(ctrlC, '   \n ')).toBe('pass');
    expect(selectionAction({ ctrl: false, name: 'c', meta: false }, 'text')).toBe('pass');
    expect(selectionAction({ ctrl: true, name: 'v', meta: false }, 'text')).toBe('pass');
  });

  test('a selection is copied without the padding of its rows', () => {
    expect(selectedText('\n  one   \ntwo  \n\n')).toBe('  one\ntwo');
  });

  test('ctrl+v is the paste key; v and alt+ctrl+v are not', () => {
    expect(isPasteKey({ ctrl: true, name: 'v', meta: false })).toBe(true);
    expect(isPasteKey({ ctrl: false, name: 'v', meta: false })).toBe(false);
    expect(isPasteKey({ ctrl: true, name: 'v', meta: true })).toBe(false);
  });

  test('a new line in the revise prompt: alt/shift+enter, ctrl+j, or a trailing backslash', () => {
    expect(isNewline({ name: 'return', meta: true }, 'x')).toBe(true);
    expect(isNewline({ name: 'return', shift: true }, 'x')).toBe(true);
    expect(isNewline({ name: 'linefeed' }, 'x')).toBe(true);
    expect(isNewline({ name: 'return' }, 'ends with \\')).toBe(true);
    expect(isNewline({ name: 'return' }, 'plain')).toBe(false);
    expect(isNewline({ name: 'a' }, '\\')).toBe(false);
  });
});
