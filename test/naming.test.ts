import { describe, expect, test } from 'bun:test';
import { buildNamePrompt, nameFromDescription, parseNames, unique } from '../src/core/naming.ts';
import { editLine, lineOf, withCursor, type Line } from '../src/tui/input.ts';
import type { KeyEvent } from '@opentui/core';

describe('naming a change from its description', () => {
  test('keeps the words that carry meaning', () => {
    expect(nameFromDescription('Let users sign in with email and password')).toBe('sign-email-password');
    expect(nameFromDescription('Fix the export timeout on large accounts')).toBe('fix-export-timeout-large');
    expect(nameFromDescription('!!!')).toBe('new-change');
  });

  test('never proposes a name that is taken', () => {
    expect(unique('add-login', ['add-login', 'add-login-2'])).toBe('add-login-3');
    expect(nameFromDescription('add login', ['add-login'])).toBe('add-login-2');
  });

  test('the model’s names are filtered to valid, free ones', () => {
    const names = parseNames(
      { name: 'add-user-login', alternatives: ['Add Login', 'taken-one', 'user-sign-in', 'add-user-login'] },
      ['taken-one'],
    );
    expect(names).toEqual(['add-user-login', 'user-sign-in']);
    expect(parseNames(null, [])).toEqual([]);
  });

  test('the prompt carries the description and what is taken', () => {
    const prompt = buildNamePrompt('Let users sign in', ['add-export']);
    expect(prompt).toContain('The change: Let users sign in');
    expect(prompt).toContain('Already taken: add-export');
  });
});

describe('line editing', () => {
  const key = (k: Partial<KeyEvent>) => k as KeyEvent;
  const type = (line: Line, ...keys: Partial<KeyEvent>[]) =>
    keys.reduce((l, k) => editLine(l, key(k)) ?? l, line);

  test('ctrl+u clears, ctrl+w drops a word', () => {
    expect(editLine(lineOf('add user login'), key({ name: 'u', ctrl: true }))).toEqual(lineOf(''));
    expect(editLine(lineOf('add user login'), key({ name: 'w', ctrl: true }))).toEqual(lineOf('add user '));
  });

  test('the arrows move the cursor, and typing goes in at it', () => {
    const line = type(lineOf('add login'), { name: 'left' }, { name: 'left' }, { name: 'left' }, { name: 'left' }, { name: 'left' });
    expect(line).toEqual({ text: 'add login', cursor: 4 });
    expect(type(line, ...[...'user '].map((c) => ({ name: c, sequence: c })))).toEqual({ text: 'add user login', cursor: 9 });
    expect(type(line, { name: 'right' })).toEqual({ text: 'add login', cursor: 5 });
  });

  test('backspace and delete work either side of the cursor', () => {
    const line = { text: 'add login', cursor: 4 };
    expect(type(line, { name: 'backspace' })).toEqual({ text: 'addlogin', cursor: 3 });
    expect(type(line, { name: 'delete' })).toEqual({ text: 'add ogin', cursor: 4 });
    expect(type(line, { name: 'u', ctrl: true })).toEqual({ text: 'login', cursor: 0 });
    expect(type(line, { name: 'k', ctrl: true })).toEqual({ text: 'add ', cursor: 4 });
  });

  test('home, end, and moving by word', () => {
    const line = { text: 'add user login', cursor: 6 };
    expect(type(line, { name: 'home' }).cursor).toBe(0);
    expect(type(line, { name: 'a', ctrl: true }).cursor).toBe(0);
    expect(type(line, { name: 'end' }).cursor).toBe(14);
    expect(type(line, { name: 'left', meta: true }).cursor).toBe(4);
    expect(type(line, { name: 'right', ctrl: true }).cursor).toBe(8);
    // Within the row of a multi-line draft.
    expect(type({ text: 'one\ntwo', cursor: 5 }, { name: 'home' }).cursor).toBe(4);
    expect(type({ text: 'one\ntwo', cursor: 1 }, { name: 'end' }).cursor).toBe(3);
  });

  test('the cursor stops at either end and never splits an emoji', () => {
    expect(type(lineOf('ab'), { name: 'right' }).cursor).toBe(2);
    expect(type({ text: 'ab', cursor: 0 }, { name: 'left' }).cursor).toBe(0);
    expect(type(lineOf('a😀'), { name: 'left' }).cursor).toBe(1);
    expect(type(lineOf('a😀'), { name: 'backspace' })).toEqual(lineOf('a'));
  });

  test('the cursor is drawn where it is', () => {
    expect(withCursor('add login', 4)).toBe('add ▏login');
    expect(withCursor('add')).toBe('add▏');
  });
});
