import { describe, expect, test } from 'bun:test';
import { buildNamePrompt, nameFromDescription, parseNames, unique } from '../src/core/naming.ts';
import { editLine } from '../src/tui/input.ts';
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
  test('ctrl+u clears, ctrl+w drops a word', () => {
    expect(editLine('add user login', key({ name: 'u', ctrl: true }))).toBe('');
    expect(editLine('add user login', key({ name: 'w', ctrl: true }))).toBe('add user ');
  });
});
