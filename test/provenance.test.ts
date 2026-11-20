/**
 * The generated-by marker on the files spec-tacular writes, and the review
 * record each change carries into the archive.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { version } from '../package.json';
import type { OpenSpecChangeStatus } from '../src/adapter/types.ts';
import { loadChangeReview } from '../src/core/change-review.ts';
import { listAdrs, promoteDecision, type Decision } from '../src/core/decisions.ts';
import { loadFoundation, parseFoundationDoc, scaffoldFoundation } from '../src/core/foundation.ts';
import { ignoredRecords, STATE_GITIGNORE, writeStateGitignore } from '../src/core/init.ts';
import { MARKER, markerLine, markerOf, stripMarker, withMarker } from '../src/core/provenance.ts';
import { renderReviewRecord, writeReviewRecord } from '../src/core/review-record.ts';
import { loadReview, saveReview, setState } from '../src/core/review.ts';
import { loadRoadmap, roadmapPath, saveRoadmap } from '../src/core/roadmap.ts';
import { hashDocument } from '../src/core/signoff.ts';

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});
const tempRoot = () => {
  const root = mkdtempSync(join(tmpdir(), 'spectacular-provenance-'));
  roots.push(root);
  return root;
};

describe('the marker', () => {
  test('is one fixed string, in a comment the file format ignores', () => {
    expect(markerLine('markdown')).toBe(`<!-- generated-by: spec-tacular ${version} -->`);
    expect(markerLine('yaml')).toBe(`# generated-by: spec-tacular ${version}`);
    expect(markerLine('markdown')).toContain(MARKER);
  });

  test('is added once', () => {
    const once = withMarker('# Title\n', 'markdown');
    expect(withMarker(once, 'markdown')).toBe(once);
    expect(markerOf(once)).toBe(markerLine('markdown'));
    expect(stripMarker(once)).toBe('# Title\n');
  });

  test('keeps the version that created the file when it is rewritten whole', () => {
    const old = '<!-- generated-by: spec-tacular 0.1.0 -->\n# Old\n';
    expect(withMarker('# New\n', 'markdown', old)).toBe('<!-- generated-by: spec-tacular 0.1.0 -->\n# New\n');
    expect(withMarker('a: 1\n', 'yaml', '# generated-by: spec-tacular 0.2.0\na: 0\n')).toBe(
      '# generated-by: spec-tacular 0.2.0\na: 1\n',
    );
  });

  test('is not content: a signed-off document does not drift for having one', () => {
    const doc = '## Why\nBecause.\n';
    expect(hashDocument(withMarker(doc, 'markdown'))).toBe(hashDocument(doc));
    expect(hashDocument(withMarker(doc, 'markdown', '<!-- generated-by: spec-tacular 0.0.1 -->\n'))).toBe(hashDocument(doc));
  });
});

describe('files spec-tacular writes carry it', () => {
  test('an ADR, whose title still reads', () => {
    const root = tempRoot();
    const decision: Decision = {
      id: 'design#use-sqlite', capability: 'design', name: 'Use SQLite', text: 'Because.', file: 'design.md',
      line: 1, hash: 'h', scope: 'global', body: 'Because.',
    } as Decision;
    const { adr } = promoteDecision(root, decision, { change: 'add-x' });
    const content = readFileSync(adr.file, 'utf8');
    expect(markerOf(content)).toBe(markerLine('markdown'));
    expect(content).toContain('**Origin:** change `add-x`');
    expect(listAdrs(root)[0]?.title).toBe('Use SQLite');
  });

  test('the foundation, whose sections read as before', () => {
    const root = tempRoot();
    scaffoldFoundation(root);
    const items = loadFoundation(root);
    expect(items.length).toBeGreaterThan(0);
    for (const file of new Set(items.map((i) => i.file))) {
      const content = readFileSync(file, 'utf8');
      expect(markerOf(content)).toBe(markerLine('markdown'));
      const name = file.split('/').at(-1)!;
      const plain = parseFoundationDoc(stripMarker(content), file, name);
      const marked = items.filter((i) => i.file === file);
      expect(marked.map((i) => [i.id, i.hash, i.text])).toEqual(plain.map((i) => [i.id, i.hash, i.text]));
    }
  });

  test('the roadmap, kept across saves', () => {
    const root = tempRoot();
    mkdirSync(join(root, 'spec-tacular'), { recursive: true });
    writeFileSync(roadmapPath(root), '# generated-by: spec-tacular 0.1.0\nvision: v\nslices: []\n');
    saveRoadmap(root, { vision: 'Kitty', slices: [] });
    expect(readFileSync(roadmapPath(root), 'utf8').startsWith('# generated-by: spec-tacular 0.1.0\n')).toBe(true);
    expect(loadRoadmap(root)?.vision).toBe('Kitty');
  });
});

const SPEC = `## ADDED Requirements

### Requirement: Amounts are integer cents
The system SHALL store amounts as integer cents.

\`\`\`formal
decision: refused = NOT participants_given
asked: Does an empty participants list mean everyone? — No, it is refused.
\`\`\`

#### Scenario: stored
- **WHEN** "12.50" is entered
- **THEN** 1250 is stored

### Requirement: Amounts accept any format
The system SHALL accept any number format.

#### Scenario: any
- **WHEN** "1e3" is entered
- **THEN** it is accepted

### Requirement: Split by shares
The system SHALL split by shares.

#### Scenario: shares
- **WHEN** shares are given
- **THEN** they are used
`;

function changeOn(root: string): OpenSpecChangeStatus {
  const changeRoot = join(root, 'openspec', 'changes', 'add-split');
  const spec = join(changeRoot, 'specs', 'expenses', 'spec.md');
  mkdirSync(join(changeRoot, 'specs', 'expenses'), { recursive: true });
  writeFileSync(spec, SPEC);
  return {
    changeName: 'add-split',
    schemaName: 'spec-tacular',
    changeRoot,
    artifactPaths: { specs: { outputPath: 'specs/**/*.md', existingOutputPaths: [spec] } },
    isPlanningComplete: false,
    applyRequires: ['tasks'],
    nextSteps: [],
    artifacts: [{ id: 'specs', status: 'done', requires: [], outputPath: 'specs/**/*.md' }],
  } as unknown as OpenSpecChangeStatus;
}

function decideAll(root: string, status: OpenSpecChangeStatus) {
  const queue = loadChangeReview(root, status);
  const [question, cents, anyFormat, shares] = queue.requirements.map((r) => r.item);
  let review = loadReview(root, 'add-split');
  review = setState(review, question!, 'accepted');
  review = setState(review, cents!, 'accepted');
  review = setState(review, anyFormat!, 'rejected', { note: '1e3 must be refused' });
  review = setState(review, shares!, 'deferred', { deferReason: 'slice 2' });
  saveReview(root, review);
}

describe('the review record', () => {
  test('says what was decided, marked, in the change folder', () => {
    const root = tempRoot();
    const status = changeOn(root);
    decideAll(root, status);
    const path = writeReviewRecord(root, status)!;
    expect(path).toBe(join(status.changeRoot, 'review.md'));
    const record = readFileSync(path, 'utf8');
    expect(markerOf(record)).toBe(markerLine('markdown'));
    expect(record).toContain('# Review: add-split');
    expect(record).toContain('2 accepted · 1 rejected · 1 deferred · 0 pending');
    expect(record).toContain('- Question on “Amounts are integer cents”: Does an empty participants list mean everyone? — No, it is refused.');
    expect(record).toContain('- Requirement (expenses): Amounts accept any format — why: 1e3 must be refused');
    expect(record).toContain('- Requirement (expenses): Split by shares — waits for: slice 2');
    expect(record).not.toContain(root);
  });

  test('is the same for the same decisions, and changes with them', () => {
    const root = tempRoot();
    const status = changeOn(root);
    decideAll(root, status);
    const queue = () => loadChangeReview(root, status, { includeDecisions: true });
    const first = renderReviewRecord(queue());
    expect(renderReviewRecord(queue())).toBe(first);
    const review = loadReview(root, 'add-split');
    const shares = queue().requirements.find((r) => r.item.name === 'Split by shares')!.item;
    saveReview(root, setState(review, shares, 'accepted'));
    expect(renderReviewRecord(queue())).not.toBe(first);
  });

  test('is not written for a change folder that has moved', () => {
    const root = tempRoot();
    const status = { ...changeOn(root), changeRoot: join(root, 'gone') };
    expect(writeReviewRecord(root, status)).toBeNull();
    expect(existsSync(join(root, 'gone'))).toBe(false);
  });
});

const hasGit = Bun.which('git') !== null;

describe('what is committed', () => {
  test.skipIf(!hasGit)('local state is ignored; the decisions are not', () => {
    const root = tempRoot();
    execFileSync('git', ['init', '-q'], { cwd: root });
    expect(writeStateGitignore(root)).toBe(true);
    expect(writeStateGitignore(root)).toBe(false);
    expect(readFileSync(join(root, '.spec-tacular', '.gitignore'), 'utf8')).toBe(STATE_GITIGNORE);
    const ignored = (path: string) => {
      try {
        execFileSync('git', ['check-ignore', '-q', '--no-index', path], { cwd: root });
        return true;
      } catch {
        return false;
      }
    };
    expect(ignored('.spec-tacular/review/add-x.json')).toBe(false);
    expect(ignored('.spec-tacular/harness/expenses.allowed.json')).toBe(false);
    expect(ignored('.spec-tacular/harness/expenses.json')).toBe(true);
    expect(ignored('.spec-tacular/usage.jsonl')).toBe(true);
    expect(ignored('.spec-tacular/evidence/add-x.jsonl')).toBe(true);
    expect(ignored('.spec-tacular/jobs/1.json')).toBe(true);
    expect(ignoredRecords(root)).toEqual([]);
  });

  test.skipIf(!hasGit)('a project that ignores the records is told', () => {
    const root = tempRoot();
    execFileSync('git', ['init', '-q'], { cwd: root });
    writeFileSync(join(root, '.gitignore'), 'spec-tacular/\n.spec-tacular/\n');
    expect(ignoredRecords(root)).toEqual(['spec-tacular/vision.md', '.spec-tacular/review/a-change.json']);
  });
});

const openspec = Bun.which('openspec');

describe('with plain OpenSpec', () => {
  test.skipIf(!openspec)('a marked change with its record validates and archives with the record', () => {
    const root = tempRoot();
    const run = (...args: string[]) => execFileSync(openspec!, args, { cwd: root, encoding: 'utf8', stdio: 'pipe' });
    execFileSync('git', ['init', '-q'], { cwd: root });
    run('init', '--tools', 'none');
    run('new', 'change', 'add-split');
    const status = changeOn(root);
    writeFileSync(join(status.changeRoot, 'proposal.md'), withMarker('## Why\nGroups need to share costs fairly between members.\n\n## What Changes\n- Split expenses\n', 'markdown'));
    writeFileSync(join(status.changeRoot, 'tasks.md'), '## 1. Do\n- [x] 1.1 Split\n');
    decideAll(root, status);
    writeReviewRecord(root, status);
    expect(run('validate', 'add-split', '--strict')).toContain('valid');
    run('archive', 'add-split', '--yes');
    const archive = join(root, 'openspec', 'changes', 'archive');
    // OpenSpec 1.14 also keeps a `.gitkeep` in the archive.
    const [moved] = readdirSync(archive).filter((e) => !e.startsWith('.'));
    expect(markerOf(readFileSync(join(archive, moved!, 'review.md'), 'utf8'))).toBe(markerLine('markdown'));
  }, 30_000);
});
