import { describe, expect, test } from 'bun:test';
import { checkOpenSpecVersion, LATEST_TESTED_MAJOR, MIN_OPENSPEC, parseVersion } from '../src/adapter/version.ts';

describe('which OpenSpec versions spec-tacular works with', () => {
  test('reads the version out of what openspec --version prints', () => {
    expect(parseVersion('1.14.0\n')).toEqual([1, 14, 0]);
    expect(parseVersion('openspec 2.0.0')).toEqual([2, 0, 0]);
    expect(parseVersion('unknown')).toBeNull();
  });

  test('OpenSpec 1 from the minimum on, and OpenSpec 2', () => {
    expect(MIN_OPENSPEC).toBe('1.11.0');
    for (const v of ['1.11.0', '1.14.3', '1.17.0', '2.0.0', '2.4.1']) {
      expect(checkOpenSpecVersion(v)).toEqual({ ok: true, version: v });
    }
  });

  test('older than the minimum is refused, with how to update', () => {
    const check = checkOpenSpecVersion('1.10.0');
    expect(check.ok).toBe(false);
    expect(check.ok ? '' : check.problem).toContain('needs 1.11.0 or newer');
    expect(checkOpenSpecVersion('0.23.0').ok).toBe(false);
  });

  test('a major newer than any tested still runs, with a warning', () => {
    const next = `${LATEST_TESTED_MAJOR + 1}.0.0`;
    const check = checkOpenSpecVersion(next);
    expect(check.ok).toBe(true);
    expect(check.ok && check.warning).toContain('newer than spec-tacular has been tested with');
  });

  test('output with no version in it is said, not guessed', () => {
    const check = checkOpenSpecVersion('');
    expect(check).toMatchObject({ ok: false, version: null });
  });
});
