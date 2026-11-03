import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  changedFiles,
  implementationDiff,
  outsideBoundary,
  parseBoundary,
  withinBoundary,
} from '../src/core/boundary.ts';

const PROPOSAL = `# Add export

## Why
Because \`not/a/boundary\`.

## Boundary
- \`src/export/\` — the new module
- \`src/**/*.sql\` and \`test/export.test.ts\`

## Impact
\`src/elsewhere.ts\`
`;

describe('parseBoundary', () => {
  test('reads the patterns of the Boundary section only', () => {
    expect(parseBoundary(PROPOSAL)).toEqual(['src/export/', 'src/**/*.sql', 'test/export.test.ts']);
  });

  test('a proposal without one declares nothing', () => {
    expect(parseBoundary('# P\n\n## Why\nx\n')).toBeNull();
  });
});

describe('withinBoundary', () => {
  const patterns = ['src/export/', 'src/**/*.sql', 'test/export.test.ts', 'docs'];

  test.each([
    ['src/export/csv.ts', true],
    ['src/export/deep/x.ts', true],
    ['src/db/migrations/001.sql', true],
    ['src/schema.sql', true],
    ['test/export.test.ts', true],
    ['docs/readme.md', true],
    ['src/exporter.ts', false],
    ['test/export.test.tsx', false],
    ['src/db/x.ts', false],
  ])('%s → %p', (path, expected) => {
    expect(withinBoundary(path, patterns)).toBe(expected);
  });

  test('`*` stays within one directory', () => {
    expect(withinBoundary('src/a/b.ts', ['src/*.ts'])).toBe(false);
    expect(withinBoundary('src/b.ts', ['src/*.ts'])).toBe(true);
  });
});

describe('outsideBoundary', () => {
  test('lists what is outside, never the tool\'s own records', () => {
    const changed = ['src/export/a.ts', 'src/other.ts', 'openspec/changes/x/tasks.md', '.spec-tacular/review/x.json'];
    expect(outsideBoundary(changed, ['src/export/'])).toEqual(['src/other.ts']);
  });
});

describe('changedFiles', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, stdio: 'ignore' });

  test('outside a repository there is nothing to compare', () => {
    const d = mkdtempSync(join(tmpdir(), 'spectacular-boundary-'));
    dirs.push(d);
    expect(changedFiles(d)).toBeNull();
  });

  test('finds what a branch committed, changed and added since it left main', () => {
    const d = mkdtempSync(join(tmpdir(), 'spectacular-boundary-'));
    dirs.push(d);
    git(d, 'init', '-q', '-b', 'main');
    writeFileSync(join(d, 'base.ts'), 'base\n');
    writeFileSync(join(d, 'kept.ts'), 'kept\n');
    git(d, 'add', '.');
    git(d, 'commit', '-qm', 'base');
    git(d, 'checkout', '-qb', 'feature');
    mkdirSync(join(d, 'src'));
    writeFileSync(join(d, 'src', 'committed.ts'), 'x\n');
    git(d, 'add', '.');
    git(d, 'commit', '-qm', 'work');
    writeFileSync(join(d, 'base.ts'), 'changed\n');
    writeFileSync(join(d, 'untracked.ts'), 'new\n');

    expect(changedFiles(d)?.sort()).toEqual(['base.ts', 'src/committed.ts', 'untracked.ts']);
  });
});

describe('implementationDiff', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, stdio: 'ignore' });

  test('shows what the branch wrote, new files included, the tool\'s records left out', () => {
    const d = mkdtempSync(join(tmpdir(), 'spectacular-diff-'));
    dirs.push(d);
    git(d, 'init', '-q', '-b', 'main');
    writeFileSync(join(d, 'gate.ts'), 'old\n');
    git(d, 'add', '.');
    git(d, 'commit', '-qm', 'base');
    git(d, 'checkout', '-qb', 'feature');
    writeFileSync(join(d, 'gate.ts'), 'new\n');
    writeFileSync(join(d, 'added.ts'), 'fresh\n');
    mkdirSync(join(d, '.spec-tacular'));
    writeFileSync(join(d, '.spec-tacular', 'review.json'), '{}\n');

    const diff = implementationDiff(d)!;
    expect(diff).toContain('-old');
    expect(diff).toContain('+new');
    expect(diff).toContain('+fresh');
    expect(diff).not.toContain('review.json');
    // The same code gives the same text, so an acceptance holds until it changes.
    expect(implementationDiff(d)).toBe(diff);
  });

  test('outside a repository there is none', () => {
    const d = mkdtempSync(join(tmpdir(), 'spectacular-diff-'));
    dirs.push(d);
    expect(implementationDiff(d)).toBeNull();
  });
});
