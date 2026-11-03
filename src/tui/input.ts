/**
 * Keyboard helpers shared by every screen that takes typed text.
 *
 * Kept in one place because the rules are subtle and must not diverge: a
 * prompt that treats alt-x as a typed "x", or waits on a lone escape, breaks
 * in exactly the terminals nobody tested.
 */

import type { KeyEvent } from '@opentui/core';
import { createSignal } from 'solid-js';

/** A key that contributes a character to a prompt, as opposed to a command. */
export function isPrintable(key: KeyEvent): boolean {
  // Length 1 excludes alt-chords, which arrive as a two-character sequence
  // beginning with ESC and would otherwise type a stray letter.
  return (
    !key.ctrl && typeof key.sequence === 'string' && key.sequence.length === 1 && key.sequence >= ' '
  );
}

/**
 * `ctrl+c`, not a bare escape, is the reliable cancel.
 *
 * A lone ESC is the prefix of every escape sequence, so a terminal parser
 * cannot deliver it until it sees what follows — pressing it alone produces
 * no event at all, and pressing it before `x` arrives as alt-x. `escape` is
 * still handled for terminals that do resolve it, but nothing depends on it.
 */
export function isCancel(key: KeyEvent): boolean {
  return key.name === 'escape' || (key.ctrl === true && key.name === 'c');
}

export function isEnter(key: KeyEvent): boolean {
  return key.name === 'return' || key.name === 'enter';
}

/** A line being typed, and where in it the cursor is (0 to `text.length`). */
export interface Line {
  text: string;
  cursor: number;
}

/** `text` with the cursor at its end, where typing continues. */
export function lineOf(text: string): Line {
  return { text, cursor: text.length };
}

/** Inserts `s` at the cursor, leaving the cursor after it. */
export function insertAt(line: Line, s: string): Line {
  return {
    text: line.text.slice(0, line.cursor) + s + line.text.slice(line.cursor),
    cursor: line.cursor + s.length,
  };
}

/** One character back or forward, never splitting a surrogate pair. */
function step(text: string, at: number, by: -1 | 1): number {
  const next = Math.min(Math.max(at + by, 0), text.length);
  const isLow = (i: number) => /[\uDC00-\uDFFF]/.test(text[i] ?? '');
  if (by < 0 && next > 0 && isLow(next)) return next - 1;
  if (by > 0 && next < text.length && isLow(next)) return next + 1;
  return next;
}

/** The start of the word before `at`, as ctrl+w and alt+left find it. */
function wordBefore(text: string, at: number): number {
  return text.slice(0, at).replace(/\S+\s*$|\s+$/, '').length;
}

/** The end of the word after `at`, as alt+right finds it. */
function wordAfter(text: string, at: number): number {
  const m = /^\s*\S+/.exec(text.slice(at));
  return at + (m ? m[0].length : text.length - at);
}

/**
 * Applies a key to a line being typed. Returns null when the key is not
 * editing, so the caller can treat it as a command.
 *
 * Home and end stay within the current row of a multi-line draft.
 */
export function editLine(line: Line, key: KeyEvent): Line | null {
  const { text, cursor } = line;
  const at = (c: number): Line => ({ text, cursor: c });
  const cut = (from: number, to: number): Line => ({ text: text.slice(0, from) + text.slice(to), cursor: from });
  const byWord = key.ctrl === true || key.meta === true || key.option === true;
  if (key.name === 'left') return at(byWord ? wordBefore(text, cursor) : step(text, cursor, -1));
  if (key.name === 'right') return at(byWord ? wordAfter(text, cursor) : step(text, cursor, 1));
  if (key.name === 'home' || (key.ctrl && key.name === 'a')) return at(text.lastIndexOf('\n', cursor - 1) + 1);
  if (key.name === 'end') {
    const eol = text.indexOf('\n', cursor);
    return at(eol === -1 ? text.length : eol);
  }
  if (key.name === 'backspace') return cut(step(text, cursor, -1), cursor);
  if (key.name === 'delete') return cut(cursor, step(text, cursor, 1));
  // The readline chords everyone's fingers know: clear to the start or the
  // end of the line, drop a word.
  if (key.ctrl && key.name === 'u') return cut(0, cursor);
  if (key.ctrl && key.name === 'k') return cut(cursor, text.length);
  if (key.ctrl && key.name === 'w') return cut(wordBefore(text, cursor), cursor);
  if (isPrintable(key)) return insertAt(line, key.sequence);
  return null;
}

/**
 * A line being typed, as a screen holds it: `set` replaces the text and puts
 * the cursor at its end, `put` replaces both, `insert` types (or pastes) at
 * the cursor, and `edit` applies a key, returning whether it was editing.
 */
export function createLine(initial = '') {
  const [line, setLine] = createSignal<Line>(lineOf(initial));
  return {
    text: () => line().text,
    cursor: () => line().cursor,
    set: (text: string) => setLine(lineOf(text)),
    put: (next: Line) => setLine(next),
    insert: (s: string) => setLine((l) => insertAt(l, s)),
    edit: (key: KeyEvent): boolean => {
      const next = editLine(line(), key);
      if (next !== null) setLine(next);
      return next !== null;
    },
  };
}

/** `text` with a cursor drawn at `cursor` — at its end when none is given. */
export function withCursor(text: string, cursor = text.length, mark = '▏'): string {
  return text.slice(0, cursor) + mark + text.slice(cursor);
}

/**
 * The same interaction has the same key on every screen. Where you are
 * typing, a bare letter is text, so the same letter takes ctrl instead.
 *
 *   a        accept — a requirement, a document, a revision
 *   r        revise with AI: say what should change (ctrl+r while typing)
 *   x        reject a requirement, saying why
 *   d        defer a requirement until it can be verified
 *   ctrl+e   open it in $EDITOR (E where nothing is typed)
 *   y        copy it
 *   q        back (ctrl+c or escape too)
 *   ?        help
 */
export const KEYS = {
  accept: 'a',
  revise: 'r',
  reject: 'x',
  defer: 'd',
  editor: 'ctrl+e',
  copy: 'y',
  back: 'q',
} as const;

/** `a`, on a screen where nothing is typed. */
export function isAccept(key: KeyEvent): boolean {
  return key.name === 'a' && !key.ctrl && !key.shift;
}

/** `r`, or ctrl+r — the only form while typing. */
export function isRevise(key: KeyEvent, typing = false): boolean {
  return key.name === 'r' && !key.shift && (key.ctrl === true || (!typing && !key.meta));
}

/** ctrl+e, or `E` where nothing is typed. */
export function isEditor(key: KeyEvent, typing = false): boolean {
  return key.name === 'e' && (key.ctrl === true || (!typing && key.shift === true));
}
