import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadLintConfig, lintText } from '../src/core/concreteness.ts';

const dirs: string[] = [];
const root = () => {
  const d = mkdtempSync(join(tmpdir(), 'spectacular-lint-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('loadLintConfig', () => {
  test('reads the project allowlist', () => {
    const r = root();
    mkdirSync(join(r, 'spec-tacular'), { recursive: true });
    writeFileSync(join(r, 'spec-tacular', 'lint.json'), JSON.stringify({ allow: ['tasks.md'] }));
    expect(loadLintConfig(r).allow).toEqual(['tasks.md']);
  });

  test('reads committed technologies from the foundation stack', () => {
    const r = root();
    mkdirSync(join(r, 'spec-tacular', 'foundation'), { recursive: true });
    writeFileSync(
      join(r, 'spec-tacular', 'foundation', 'stack.md'),
      '# Stack\n\nRuntime: `Bun`. Database: `Postgres`.\n',
    );
    const config = loadLintConfig(r);
    expect(config.stack).toEqual(['Bun', 'Postgres']);
    // And naming one is then a decision made, not a premature one.
    expect(lintText('Persists via `Postgres`.', config)).toEqual([]);
  });

  test('an absent config is empty, not an error', () => {
    expect(loadLintConfig(root())).toEqual({ allow: [], stack: [] });
  });

  test('a broken config degrades rather than stopping a review', () => {
    // The cost of ignoring it is a few extra questions, which is the
    // linter's whole failure mode anyway.
    const r = root();
    mkdirSync(join(r, 'spec-tacular'), { recursive: true });
    writeFileSync(join(r, 'spec-tacular', 'lint.json'), '{not json');
    expect(loadLintConfig(r).allow).toEqual([]);
  });

  test('non-string allowlist entries are ignored', () => {
    const r = root();
    mkdirSync(join(r, 'spec-tacular'), { recursive: true });
    writeFileSync(join(r, 'spec-tacular', 'lint.json'), JSON.stringify({ allow: ['ok', 42, null] }));
    expect(loadLintConfig(r).allow).toEqual(['ok']);
  });
});
