/**
 * Keyboard helpers shared by every screen that takes typed text.
 *
 * Kept in one place because the rules are subtle and must not diverge: a
 * prompt that treats alt-x as a typed "x", or waits on a lone escape, breaks
 * in exactly the terminals nobody tested.
 */

import type { KeyEvent } from '@opentui/core';

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

/**
 * Applies a key to a line being typed. Returns null when the key is not
 * editing, so the caller can treat it as a command.
 */
export function editLine(draft: string, key: KeyEvent): string | null {
  if (key.name === 'backspace') return draft.slice(0, -1);
  // The readline chords everyone's fingers know: clear the line, drop a word.
  if (key.ctrl && key.name === 'u') return '';
  if (key.ctrl && key.name === 'w') return draft.replace(/\S+\s*$/, '');
  if (isPrintable(key)) return draft + key.sequence;
  return null;
}
